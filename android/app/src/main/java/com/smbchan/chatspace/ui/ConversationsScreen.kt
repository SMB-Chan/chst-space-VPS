package com.smbchan.chatspace.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.smbchan.chatspace.data.ChatApi
import com.smbchan.chatspace.data.Conversation
import kotlinx.coroutines.launch

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ConversationsScreen(
    api: ChatApi,
    version: Int,
    onOpen: (Conversation) -> Unit,
    onDeleted: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var conversations by remember { mutableStateOf<List<Conversation>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pendingDelete by remember { mutableStateOf<Conversation?>(null) }

    suspend fun reload() {
        try {
            conversations = api.listConversations()
            error = null
        } catch (e: Exception) {
            error = e.message ?: "会話一覧の取得に失敗しました"
        }
    }

    LaunchedEffect(version) { reload() }

    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        if (conversations == null && error == null) {
            item {
                Text(
                    "読み込み中...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
        error?.let { message ->
            item {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "設定でサーバーURLを確認してください (タップで再試行)",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .padding(top = 6.dp)
                            .clickable {
                                scope.launch { reload() }
                            },
                    )
                }
            }
        }
        conversations?.let { list ->
            if (list.isEmpty()) {
                item {
                    Text(
                        "まだ会話がありません。右下の「新しい会話」から始めましょう。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
            items(list) { conversation ->
                ConversationRow(
                    conversation = conversation,
                    onOpen = { onOpen(conversation) },
                    onDeleteRequest = { pendingDelete = conversation },
                )
            }
        }
    }

    pendingDelete?.let { target ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            title = { Text("会話を削除") },
            text = { Text("「${target.title}」を削除します。元に戻せません。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        val id = target.id
                        pendingDelete = null
                        scope.launch {
                            runCatching { api.deleteConversation(id) }
                                .onSuccess {
                                    onDeleted()
                                    reload()
                                }
                                .onFailure { error = it.message ?: "削除に失敗しました" }
                        }
                    },
                ) { Text("削除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("キャンセル") }
            },
        )
    }
}

private val timeFormatter = DateTimeFormatter.ofPattern("M/d HH:mm")

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: Conversation,
    onOpen: () -> Unit,
    onDeleteRequest: () -> Unit,
) {
    val timeText = remember(conversation.createdAt) {
        runCatching {
            Instant.parse(conversation.createdAt).atZone(ZoneId.systemDefault()).format(timeFormatter)
        }.getOrElse { "" }
    }
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .combinedClickable(
                onClick = onOpen,
                onLongClick = onDeleteRequest,
            ),
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(
                conversation.title,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
            )
            if (timeText.isNotEmpty()) {
                Text(
                    timeText,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
    }
}
