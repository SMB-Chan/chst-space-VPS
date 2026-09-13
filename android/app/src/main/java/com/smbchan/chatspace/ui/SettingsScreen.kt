package com.smbchan.chatspace.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.smbchan.chatspace.data.ChatApi
import com.smbchan.chatspace.data.ModelInfo
import com.smbchan.chatspace.data.SettingsStore
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    api: ChatApi,
    settings: SettingsStore,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var serverUrl by remember { mutableStateOf(settings.serverUrl) }
    var saved by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var reasoning by remember { mutableStateOf(settings.reasoningLevel) }

    suspend fun testConnection() {
        try {
            val list = api.listModels()
            models = list
            testResult = "接続OK: モデル${list.size}件"
        } catch (e: Exception) {
            testResult = "接続失敗: ${e.message}"
        }
    }

    LaunchedEffect(Unit) { testConnection() }

    Column(
        verticalArrangement = Arrangement.spacedBy(14.dp),
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text("サーバー", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = serverUrl,
            onValueChange = {
                serverUrl = it
                saved = false
            },
            label = { Text("サーバーURL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                settings.serverUrl = serverUrl
                saved = true
                scope.launch { testConnection() }
            }) { Text(if (saved) "保存しました" else "保存して接続テスト") }
            TextButton(onClick = {
                serverUrl = SettingsStore.DEFAULT_SERVER_URL
                settings.serverUrl = SettingsStore.DEFAULT_SERVER_URL
                saved = false
                scope.launch { testConnection() }
            }) { Text("既定に戻す") }
        }
        testResult?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = if (it.startsWith("接続OK")) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.error
                },
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        Text("モデル", style = MaterialTheme.typography.titleMedium)
        if (models.isEmpty()) {
            Text(
                "モデル一覧を取得できません。サーバーURLを確認してください。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        models.forEach { model ->
        Surface(
                shape = RoundedCornerShape(12.dp),
                color = if (model.id == settings.selectedModel) {
                    MaterialTheme.colorScheme.primaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceContainer
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp),
                onClick = {
                    settings.selectedModel = model.id
                },
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    RadioButton(
                        selected = model.id == settings.selectedModel,
                        onClick = {
                            settings.selectedModel = model.id
                        },
                    )
                    Column(modifier = Modifier.padding(vertical = 6.dp)) {
                        Text(model.label, style = MaterialTheme.typography.bodyLarge)
                        model.description?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        Text("推論レベル (既定)", style = MaterialTheme.typography.titleMedium)
        SettingsStore.REASONING_LEVELS.forEach { level ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 0.dp),
            ) {
                RadioButton(
                    selected = level == reasoning,
                    onClick = {
                        reasoning = level
                        settings.reasoningLevel = level
                    },
                )
                Text(
                    when (level) {
                        "off" -> "オフ"
                        "low" -> "低"
                        "high" -> "高"
                        else -> "中"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        Text(
            "Chat Space Android クライアント v1.0\n自己ホストの Chat-Space サーバー (AUTH_MODE=local) に接続します。Tailscale ネットワーク内でご利用ください。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
