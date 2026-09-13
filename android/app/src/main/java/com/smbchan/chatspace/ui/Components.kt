package com.smbchan.chatspace.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.smbchan.chatspace.data.ChatMessage
import com.smbchan.chatspace.data.ModelInfo
import com.smbchan.chatspace.data.Source

private val accent get() = MaterialTheme.colorScheme.primary

/** トップバーのモデル選択メニュー。 */
@Composable
fun ModelMenuButton(
    models: List<ModelInfo>,
    selectedModel: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = models.firstOrNull { it.id == selectedModel }
    IconButton(onClick = { expanded = true }) {
        Icon(Icons.Filled.SmartToy, contentDescription = "モデル選択")
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
        if (models.isEmpty()) {
            DropdownMenuItem(text = { Text("モデル情報を取得中...") }, onClick = { expanded = false })
        }
        models.forEach { model ->
            DropdownMenuItem(
                text = {
                    Column {
                        Text(
                            model.label,
                            fontWeight = if (model.id == selectedModel) FontWeight.Bold else FontWeight.Normal,
                            color = if (model.id == selectedModel) accent else MaterialTheme.colorScheme.onSurface,
                        )
                        model.description?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                onClick = {
                    onSelect(model.id)
                    expanded = false
                },
                trailingIcon = {
                    if (model.id == selectedModel) {
                        Icon(Icons.Filled.AutoAwesome, contentDescription = null, tint = accent, modifier = Modifier.size(16.dp))
                    }
                },
            )
        }
    }
}

private fun phaseLabel(kind: String, query: String?, step: Int?, maxSteps: Int?): String = when (kind) {
    "starting" -> "準備中"
    "thinking" -> "推論中"
    "searching" -> if (!query.isNullOrBlank()) "「$query」を検索中" else "Webを検索中"
    "fetching" -> "ページを取得中"
    "researching" -> if (step != null && maxSteps != null) "情報を収集中 ($step/$maxSteps)" else "情報を収集中"
    "reading-images" -> "画像を読み取り中"
    "reading-files" -> "ファイルを解析中"
    "generating" -> "生成中"
    "generating-file" -> "ファイルを生成中"
    "auditing" -> "監査中"
    "verifying" -> "根拠を検証中"
    "revising" -> "最終報告を作成中"
    "specialist" -> "専門能力を実行中"
    else -> "準備中"
}

private fun phaseIcon(kind: String): ImageVector = when (kind) {
    "searching", "fetching" -> Icons.Filled.Public
    "researching" -> Icons.Filled.Search
    "generating" -> Icons.Filled.AutoAwesome
    else -> Icons.Filled.Psychology
}

/** ChatGPT/Gemini 風: 呼吸するグラデーションオーブ + シマーラベル + 経過秒。 */
@Composable
fun ThinkingIndicator(statusKind: String, query: String?, step: Int?, maxSteps: Int?, elapsedSeconds: Int) {
    val transition = rememberInfiniteTransition(label = "thinking")
    val breathe by transition.animateFloat(
        initialValue = 0.85f,
        targetValue = 1.1f,
        animationSpec = infiniteRepeatable(tween(1200), RepeatMode.Reverse),
        label = "breathe",
    )
    val sweep by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2600, easing = LinearEasing)),
        label = "sweep",
    )
    val label = phaseLabel(statusKind, query, step, maxSteps)
    val icon = phaseIcon(statusKind)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.size(30.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .scale(breathe)
                    .background(
                        Brush.radialGradient(listOf(accent.copy(alpha = 0.35f), Color.Transparent)),
                        CircleShape,
                    ),
            )
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(19.dp)
                    .scale(breathe)
                    .background(
                        Brush.linearGradient(listOf(accent, Color(0xFFB48CF2))),
                        CircleShape,
                    ),
            ) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(11.dp),
                )
            }
        }
        val start = Offset(sweep * 700f - 350f, 0f)
        Text(
            label,
            style = TextStyle(
                brush = Brush.linearGradient(
                    colors = listOf(muted, muted, accent, muted, muted),
                    start = start,
                    end = Offset(start.x + 350f, 0f),
                ),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            ),
        )
        if (elapsedSeconds > 0) {
            Text(
                " ${elapsedSeconds}秒",
                style = MaterialTheme.typography.labelSmall,
                color = muted.copy(alpha = 0.7f),
            )
        }
    }
}

/** 1件のメッセージ吹き出し。 */
@Composable
fun MessageBubble(message: ChatMessage, isStreaming: Boolean = false) {
    val isUser = message.role == "user"
    val bubbleShape = if (isUser) {
        RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
    } else {
        RoundedCornerShape(6.dp, 20.dp, 20.dp, 20.dp)
    }
    Column(
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
        modifier = Modifier.widthIn(max = 340.dp),
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 340.dp)
                .then(
                    if (isUser) {
                        Modifier.background(
                            Brush.linearGradient(
                                listOf(accent, accent.copy(alpha = 0.8f)),
                            ),
                            bubbleShape,
                        )
                    } else {
                        Modifier
                            .background(MaterialTheme.colorScheme.surfaceContainer, bubbleShape)
                            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f), bubbleShape)
                    },
                )
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            if (isUser) {
                Text(
                    message.content,
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                MarkdownText(markdown = message.content)
            }
        }
        if (!message.sources.isNullOrEmpty()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(top = 6.dp, start = 2.dp),
            ) {
                message.sources.take(4).forEach { source ->
                    SourceChip(source)
                }
            }
        }
    }
}

@Composable
fun SourceChip(source: Source) {
    val uriHandler = LocalUriHandler.current
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.clickable { runCatching { uriHandler.openUri(source.url) } },
    ) {
        Text(
            source.title,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}
