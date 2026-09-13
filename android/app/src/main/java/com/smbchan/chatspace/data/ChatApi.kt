package com.smbchan.chatspace.data

import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** SSE ストリームから受け取るイベント。 */
sealed interface StreamEvent {
    data class Content(val text: String) : StreamEvent
    data class Status(val kind: String, val query: String? = null) : StreamEvent
    data class ResearchStep(val step: Int, val maxSteps: Int) : StreamEvent
    data class SourcesEvent(val sources: List<Source>) : StreamEvent
    data class ServerError(val message: String) : StreamEvent
    data object Done : StreamEvent
}

/**
 * Chat-Space サーバー (AUTH_MODE=local) への REST + SSE クライアント。
 * ベースURLは設定で変更できるため lambda で毎回解決する。
 */
class ChatApi(private val baseUrl: () -> String) {

    private val json = Json { ignoreUnknownKeys = true }

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private fun url(path: String): String = baseUrl().trimEnd('/') + path

    suspend fun listConversations(): List<Conversation> = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url("/api/openai/conversations")).build())
            .execute().use { res ->
                check(res.isSuccessful) { "会話一覧の取得に失敗しました (HTTP ${res.code})" }
                json.decodeFromString(res.body?.string() ?: "[]")
            }
    }

    suspend fun getConversation(id: Int): ConversationWithMessages = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url("/api/openai/conversations/$id")).build())
            .execute().use { res ->
                check(res.isSuccessful) { "会話の取得に失敗しました (HTTP ${res.code})" }
                json.decodeFromString(res.body?.string() ?: "{}")
            }
    }

    suspend fun listModels(): List<ModelInfo> = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url("/api/openai/models")).build())
            .execute().use { res ->
                check(res.isSuccessful) { "モデル一覧の取得に失敗しました (HTTP ${res.code})" }
                json.decodeFromString(res.body?.string() ?: "[]")
            }
    }

    suspend fun createConversation(title: String): Conversation = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ConversationInput(title))
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url(url("/api/openai/conversations"))
            .post(body)
            .build()
        client.newCall(req).execute().use { res ->
            check(res.isSuccessful) { "会話の作成に失敗しました (HTTP ${res.code})" }
            json.decodeFromString(res.body?.string() ?: "{}")
        }
    }

    suspend fun deleteConversation(id: Int): Unit = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(url("/api/openai/conversations/$id"))
            .delete()
            .build()
        client.newCall(req).execute().use { res ->
            check(res.isSuccessful || res.code == 204) { "会話の削除に失敗しました (HTTP ${res.code})" }
        }
    }

    /**
     * メッセージを送信し SSE を末尾まで読む。呼び出し元コルーチンのキャンセルで
     * 接続を閉じる (生成停止ボタンの実装)。
     * auditModel / translateMode は Web 版と同じクエリパラメータで渡す。
     */
    suspend fun streamMessage(
        conversationId: Int,
        content: String,
        model: String,
        reasoning: String,
        auditModel: String? = null,
        translateMode: String? = null,
        onEvent: (StreamEvent) -> Unit,
    ): Unit = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(MessageInput(content = content, modelId = model))
            .toRequestBody("application/json".toMediaType())
        val query = buildString {
            append("model=").append(Uri.encode(model))
            append("&reasoning=").append(Uri.encode(reasoning))
            if (!auditModel.isNullOrBlank()) {
                append("&auditModel=").append(Uri.encode(auditModel))
                append("&auditReasoning=off")
            }
            if (!translateMode.isNullOrBlank() && translateMode != "off") {
                append("&translate=").append(Uri.encode(translateMode))
            }
        }
        val req = Request.Builder()
            .url(url("/api/openai/conversations/$conversationId/messages?$query"))
            .post(payload)
            .header("Accept", "text/event-stream")
            .build()

        val call = client.newCall(req)
        val cancellationHandle: Job? = coroutineContext[Job]
        val handle = cancellationHandle?.invokeOnCompletion { call.cancel() }
        try {
            call.execute().use { res ->
                check(res.isSuccessful) { "送信に失敗しました (HTTP ${res.code})" }
                val reader = res.body?.byteStream()?.bufferedReader(Charsets.UTF_8)
                    ?: error("応答ストリームを開けませんでした")
                while (true) {
                    val line = reader.readLine() ?: break
                    if (!line.startsWith("data: ")) continue
                    val payloadLine = line.removePrefix("data: ").trim()
                    val event = parseEvent(payloadLine) ?: continue
                    onEvent(event)
                    if (event is StreamEvent.Done || event is StreamEvent.ServerError) return@use
                }
            }
        } finally {
            handle?.dispose()
        }
    }

    private fun parseEvent(payload: String): StreamEvent? {
        if (payload.isBlank()) return null
        return try {
            val obj = json.parseToJsonElement(payload).jsonObject

            val done = obj["done"]?.jsonPrimitive?.booleanOrNull ?: false
            if (done) return StreamEvent.Done

            (obj["error"]?.jsonPrimitive?.contentOrNull)?.let { return StreamEvent.ServerError(it) }

            (obj["content"]?.jsonPrimitive?.contentOrNull)?.takeIf { it.isNotEmpty() }
                ?.let { return StreamEvent.Content(it) }

            when (val status = obj["status"]?.jsonPrimitive?.contentOrNull) {
                null -> Unit
                "searching", "fetching", "thinking", "generating", "auditing",
                "verifying", "revising", "reading-images", "reading-files",
                "generating-file", "reviewing-layout", "revising-layout",
                -> return StreamEvent.Status(status)
                "researching" -> {
                    val step = obj["step"]?.jsonPrimitive?.intOrNull
                    val max = obj["maxSteps"]?.jsonPrimitive?.intOrNull
                    return if (step != null && max != null) {
                        StreamEvent.ResearchStep(step, max)
                    } else {
                        StreamEvent.Status(status)
                    }
                }
                else -> return StreamEvent.Status(status)
            }

            (obj["sources"] as? kotlinx.serialization.json.JsonArray)?.let { arr ->
                val sources = arr.mapNotNull { element ->
                    runCatching {
                        val source = element.jsonObject
                        Source(
                            title = source["title"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                            url = source["url"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                        )
                    }.getOrNull()
                }
                if (sources.isNotEmpty()) return StreamEvent.SourcesEvent(sources)
            }

            (obj["audit"]?.jsonPrimitive?.contentOrNull)?.takeIf { it.isNotEmpty() }
                ?.let { return StreamEvent.Status("auditing") }

            null
        } catch (e: Exception) {
            null
        }
    }
}
