package com.smbchan.chatspace.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.smbchan.chatspace.data.ChatApi
import com.smbchan.chatspace.data.ChatMessage
import com.smbchan.chatspace.data.Haptics
import com.smbchan.chatspace.data.ModelInfo
import com.smbchan.chatspace.data.SettingsStore
import com.smbchan.chatspace.data.Source
import com.smbchan.chatspace.data.StreamEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 監査モデルの選択 (Web版 pickAuditModel と同じ方針: 別プロバイダ優先)。 */
fun pickAuditModel(primaryId: String, models: List<ModelInfo>): String? {
    if (models.isEmpty()) return null
    val primary = models.find { it.id == primaryId }
    val otherProvider = models.find {
        it.id != primaryId && it.provider != null && it.provider != primary?.provider
    }
    return otherProvider?.id ?: models.find { it.id != primaryId }?.id ?: primaryId
}

/** チャット1画面分の状態とストリーム制御。 */
class ChatSession(
    private val api: ChatApi,
    private val haptics: Haptics?,
) {
    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var streamingContent by mutableStateOf("")
        private set
    var statusKind by mutableStateOf("starting")
        private set
    var statusQuery by mutableStateOf<String?>(null)
        private set
    var researchStep by mutableStateOf<Pair<Int, Int>?>(null)
        private set
    var streamingSources by mutableStateOf<List<Source>>(emptyList())
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var historyLoaded by mutableStateOf(false)
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamJob: Job? = null

    fun loadHistory(conversationId: Int) {
        if (historyLoaded) return
        historyLoaded = true
        scope.launch {
            runCatching { api.getConversation(conversationId) }
                .onSuccess { messages = it.messages }
                .onFailure { error = it.message ?: "会話の読み込みに失敗しました" }
        }
    }

    fun cancel() {
        streamJob?.cancel()
        finalizePartial()
        busy = false
    }

    fun send(
        conversationId: Int?,
        content: String,
        model: String,
        reasoning: String,
        auditModel: String?,
        translateMode: String?,
        onConversationCreated: (Int, String) -> Unit,
    ) {
        val text = content.trim()
        if (text.isEmpty() || busy) return
        messages = messages + ChatMessage(role = "user", content = text)
        busy = true
        error = null
        streamingContent = ""
        statusKind = "starting"
        statusQuery = null
        researchStep = null
        streamingSources = emptyList()
        haptics?.tick()

        streamJob = scope.launch {
            try {
                val targetId = conversationId
                    ?: api.createConversation(text.take(80)).also {
                        onConversationCreated(it.id, it.title)
                    }.id
                api.streamMessage(
                    conversationId = targetId,
                    content = text,
                    model = model,
                    reasoning = reasoning,
                    auditModel = auditModel,
                    translateMode = translateMode,
                    onEvent = ::applyEvent,
                )
                // 監査リバイズ等でサーバー側に確定済みの最終本文があるため再取得で上書き
                runCatching { api.getConversation(targetId) }.getOrNull()?.let {
                    if (it.messages.isNotEmpty()) messages = it.messages
                }
                streamingContent = ""
                haptics?.done()
            } catch (cancelled: CancellationException) {
                finalizePartial()
                throw cancelled
            } catch (failure: Exception) {
                finalizePartial()
                error = failure.message ?: "エラーが発生しました"
                haptics?.error()
            } finally {
                busy = false
                statusKind = "starting"
                statusQuery = null
                researchStep = null
            }
        }
    }

    private fun finalizePartial() {
        val partial = streamingContent.trim()
        if (partial.isNotEmpty()) {
            messages = messages + ChatMessage(
                role = "assistant",
                content = partial,
                sources = streamingSources.takeIf { it.isNotEmpty() },
            )
        }
        streamingContent = ""
    }

    private fun applyEvent(event: StreamEvent) {
        when (event) {
            is StreamEvent.Content -> streamingContent += event.text
            is StreamEvent.Status -> {
                if (event.kind != statusKind) haptics?.phaseChange()
                statusKind = event.kind
                statusQuery = event.query
            }
            is StreamEvent.ResearchStep -> {
                if (statusKind != "researching") haptics?.phaseChange()
                statusKind = "researching"
                researchStep = event.step to event.maxSteps
            }
            is StreamEvent.SourcesEvent -> streamingSources = event.sources
            is StreamEvent.ServerError -> {
                error = event.message
                haptics?.error()
            }
            is StreamEvent.Done -> Unit
        }
    }
}

@Composable
fun ChatScreen(
    api: ChatApi,
    settings: SettingsStore,
    conversationId: Int?,
    initialTitle: String,
    models: List<ModelInfo>,
    modelsError: String?,
    selectedModel: String,
    onSelectModel: (String) -> Unit,
    reasoningLevel: String,
    onReasoningChange: (String) -> Unit,
    auditEnabled: Boolean,
    onAuditChange: (Boolean) -> Unit,
    translationMode: String,
    onTranslationChange: (String) -> Unit,
    onConversationCreated: (Int, String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val haptics = remember { Haptics(context) { settings.hapticsEnabled } }
    val session = remember { ChatSession(api, haptics) }
    var draft by remember { mutableStateOf("") }
    var elapsedSeconds by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()

    LaunchedEffect(conversationId) {
        if (conversationId != null && conversationId > 0) session.loadHistory(conversationId)
    }

    LaunchedEffect(session.busy) {
        if (!session.busy) {
            elapsedSeconds = 0
        } else {
            val start = System.currentTimeMillis()
            while (true) {
                elapsedSeconds = ((System.currentTimeMillis() - start) / 1000).toInt()
                delay(1000)
            }
        }
    }

    // 新着があれば自動スクロール (最下部付近にいる場合のみ)
    val itemCount = session.messages.size + if (session.busy) 1 else 0
    LaunchedEffect(itemCount, session.streamingContent) {
        val info = listState.layoutInfo
        val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: 0
        if (itemCount > 0 && lastVisible >= itemCount - 2) {
            listState.animateScrollToItem(itemCount - 1)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            verticalArrangement = Arrangement.spacedBy(14.dp),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp),
        ) {
            if (session.messages.isEmpty() && !session.busy) {
                item {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 80.dp),
                    ) {
                        Text(
                            "Chat Space",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                        Text(
                            "下の入力欄から質問をどうぞ",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
            items(session.messages) { message ->
                Row(modifier = Modifier.fillMaxWidth()) {
                    if (message.role == "user") {
                        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                            MessageBubble(message)
                        }
                    } else {
                        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                            MessageBubble(message)
                        }
                    }
                }
            }
            if (session.busy) {
                item(key = "streaming") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ThinkingIndicator(
                            statusKind = session.statusKind,
                            query = session.statusQuery,
                            step = session.researchStep?.first,
                            maxSteps = session.researchStep?.second,
                            elapsedSeconds = elapsedSeconds,
                        )
                        if (session.streamingContent.isNotEmpty()) {
                            MessageBubble(
                                message = ChatMessage(
                                    role = "assistant",
                                    content = session.streamingContent,
                                    sources = session.streamingSources.takeIf { it.isNotEmpty() },
                                ),
                            )
                        }
                        session.error?.let {
                            Text(
                                "エラー: $it",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(horizontal = 4.dp),
                            )
                        }
                    }
                }
            }
        }

        modelsError?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
            )
        }

        // 入力バー (ツールチップ + テキスト欄)
        Surface(tonalElevation = 2.dp) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                ComposerToolbar(
                    models = models,
                    selectedModel = selectedModel,
                    onSelectModel = onSelectModel,
                    reasoningLevel = reasoningLevel,
                    onReasoningChange = onReasoningChange,
                    auditEnabled = auditEnabled,
                    onAuditChange = onAuditChange,
                    translationMode = translationMode,
                    onTranslationChange = onTranslationChange,
                )
                Row(verticalAlignment = Alignment.Bottom) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it },
                        placeholder = { Text("メッセージを入力...") },
                        modifier = Modifier.weight(1f),
                        maxLines = 6,
                        shape = RoundedCornerShape(22.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = MaterialTheme.colorScheme.primary,
                            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                        ),
                    )
                    val canSend = draft.isNotBlank() && !session.busy && selectedModel.isNotEmpty()
                    if (session.busy) {
                        IconButton(
                            onClick = { session.cancel() },
                            modifier = Modifier
                                .padding(start = 6.dp, bottom = 4.dp)
                                .size(46.dp)
                                .background(
                                    MaterialTheme.colorScheme.errorContainer,
                                    RoundedCornerShape(999.dp),
                                ),
                        ) {
                            Icon(
                                Icons.Filled.Stop,
                                contentDescription = "生成を停止",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    } else {
                        val sendAlpha by animateFloatAsState(
                            targetValue = if (canSend) 1f else 0.4f,
                            animationSpec = tween(150),
                            label = "sendAlpha",
                        )
                        IconButton(
                            onClick = {
                                val text = draft
                                draft = ""
                                val auditModel = if (auditEnabled) {
                                    pickAuditModel(selectedModel, models)
                                } else {
                                    null
                                }
                                session.send(
                                    conversationId = conversationId?.takeIf { it > 0 },
                                    content = text,
                                    model = selectedModel,
                                    reasoning = reasoningLevel,
                                    auditModel = auditModel,
                                    translateMode = translationMode,
                                    onConversationCreated = onConversationCreated,
                                )
                            },
                            enabled = canSend,
                            modifier = Modifier
                                .padding(start = 6.dp, bottom = 4.dp)
                                .size(46.dp)
                                .alpha(sendAlpha)
                                .background(
                                    Brush.linearGradient(
                                        listOf(
                                            MaterialTheme.colorScheme.primary,
                                            MaterialTheme.colorScheme.primary.copy(alpha = 0.82f),
                                        ),
                                    ),
                                    RoundedCornerShape(999.dp),
                                ),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = "送信",
                                tint = MaterialTheme.colorScheme.onPrimary,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun reasoningLabel(level: String): String = when (level) {
    "off" -> "オフ"
    "low" -> "低"
    "high" -> "高"
    else -> "中"
}

/** モデル/推論/監査/翻訳を選べる横スクロールのツールチップ。 */
@Composable
private fun ComposerToolbar(
    models: List<ModelInfo>,
    selectedModel: String,
    onSelectModel: (String) -> Unit,
    reasoningLevel: String,
    onReasoningChange: (String) -> Unit,
    auditEnabled: Boolean,
    onAuditChange: (Boolean) -> Unit,
    translationMode: String,
    onTranslationChange: (String) -> Unit,
) {
    var modelMenu by remember { mutableStateOf(false) }
    var reasoningMenu by remember { mutableStateOf(false) }
    var auditMenu by remember { mutableStateOf(false) }
    var translateMenu by remember { mutableStateOf(false) }
    val activeColor = MaterialTheme.colorScheme.primary
    val inactiveColor = MaterialTheme.colorScheme.onSurfaceVariant

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
    ) {
        // モデル
        Box {
            ToolChip(
                label = models.find { it.id == selectedModel }?.label ?: "モデル",
                color = inactiveColor,
                onClick = { modelMenu = true },
            )
            DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                if (models.isEmpty()) {
                    DropdownMenuItem(text = { Text("モデル一覧を取得中...") }, onClick = {})
                }
                models.forEach { model ->
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(
                                    model.label,
                                    fontWeight = if (model.id == selectedModel) FontWeight.Bold else FontWeight.Normal,
                                    color = if (model.id == selectedModel) activeColor else MaterialTheme.colorScheme.onSurface,
                                )
                                model.description?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        },
                        onClick = {
                            onSelectModel(model.id)
                            modelMenu = false
                        },
                    )
                }
            }
        }
        // 推論
        Box {
            ToolChip(
                label = "推論: ${reasoningLabel(reasoningLevel)}",
                color = inactiveColor,
                onClick = { reasoningMenu = true },
            )
            DropdownMenu(expanded = reasoningMenu, onDismissRequest = { reasoningMenu = false }) {
                SettingsStore.REASONING_LEVELS.forEach { level ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                "推論: ${reasoningLabel(level)}",
                                color = if (level == reasoningLevel) activeColor else MaterialTheme.colorScheme.onSurface,
                            )
                        },
                        onClick = {
                            onReasoningChange(level)
                            reasoningMenu = false
                        },
                    )
                }
            }
        }
        // 監査
        Box {
            ToolChip(
                label = if (auditEnabled) "監査 ON" else "監査 OFF",
                color = if (auditEnabled) activeColor else inactiveColor,
                onClick = { auditMenu = true },
            )
            DropdownMenu(expanded = auditMenu, onDismissRequest = { auditMenu = false }) {
                DropdownMenuItem(
                    text = { Text("中立監査を有効にする") },
                    trailingIcon = {
                        Switch(checked = auditEnabled, onCheckedChange = onAuditChange)
                    },
                    onClick = { onAuditChange(!auditEnabled) },
                )
                if (auditEnabled) {
                    val auditModelId = pickAuditModel(selectedModel, models)
                    val auditLabel = models.find { it.id == auditModelId }?.label ?: ""
                    DropdownMenuItem(
                        text = {
                            Text(
                                "点検モデル: $auditLabel",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                        onClick = {},
                    )
                }
            }
        }
        // 翻訳
        Box {
            val translateLabel = SettingsStore.TRANSLATION_MODES
                .find { it.first == translationMode }?.second ?: "翻訳: オフ"
            ToolChip(
                label = translateLabel,
                color = if (translationMode != "off") activeColor else inactiveColor,
                onClick = { translateMenu = true },
            )
            DropdownMenu(expanded = translateMenu, onDismissRequest = { translateMenu = false }) {
                SettingsStore.TRANSLATION_MODES.forEach { (mode, label) ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                label,
                                color = if (mode == translationMode) activeColor else MaterialTheme.colorScheme.onSurface,
                            )
                        },
                        onClick = {
                            onTranslationChange(mode)
                            translateMenu = false
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolChip(label: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = color)
            Icon(
                Icons.Filled.ExpandMore,
                contentDescription = null,
                tint = color,
                modifier = Modifier
                    .padding(start = 2.dp)
                    .size(14.dp),
            )
        }
    }
}
