package com.smbchan.chatspace.ui

import androidx.compose.foundation.layout.padding
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.smbchan.chatspace.data.ChatApi
import com.smbchan.chatspace.data.ModelInfo
import com.smbchan.chatspace.data.SettingsStore

sealed interface Screen {
    data object Conversations : Screen
    data class Chat(val conversationId: Int?, val title: String) : Screen
    data object Settings : Screen
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatSpaceApp() {
    val context = LocalContext.current
    val settings = remember { SettingsStore(context) }
    val api = remember { ChatApi({ settings.serverUrl }) }

    var screen by remember { mutableStateOf<Screen>(Screen.Conversations) }
    var models by remember { mutableStateOf<List<ModelInfo>>(emptyList()) }
    var modelsError by remember { mutableStateOf<String?>(null) }
    var selectedModel by remember { mutableStateOf(settings.selectedModel) }
    var reasoningLevel by remember { mutableStateOf(settings.reasoningLevel) }
    var listVersion by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) {
        runCatching { api.listModels() }
            .onSuccess { list ->
                models = list
                if (list.isNotEmpty() && list.none { it.id == selectedModel }) {
                    selectedModel = list.first().id
                    settings.selectedModel = selectedModel
                }
            }
            .onFailure { modelsError = it.message }
    }

    BackHandler(enabled = screen !is Screen.Conversations) {
        screen = Screen.Conversations
    }

    Scaffold(
        topBar = {
            when (val current = screen) {
                is Screen.Chat -> {
                    TopAppBar(
                        title = {
                            Text(current.title, maxLines = 1, style = MaterialTheme.typography.titleMedium)
                        },
                        navigationIcon = {
                            IconButton(onClick = { screen = Screen.Conversations }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                            }
                        },
                        actions = {
                            ModelMenuButton(
                                models = models,
                                selectedModel = selectedModel,
                                onSelect = {
                                    selectedModel = it
                                    settings.selectedModel = it
                                },
                            )
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                        ),
                    )
                }
                Screen.Conversations -> {
                    TopAppBar(
                        title = { Text("Chat Space", style = MaterialTheme.typography.titleLarge) },
                        actions = {
                            IconButton(onClick = { screen = Screen.Settings }) {
                                Icon(Icons.Filled.Settings, contentDescription = "設定")
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                        ),
                    )
                }
                Screen.Settings -> {
                    TopAppBar(
                        title = { Text("設定", style = MaterialTheme.typography.titleLarge) },
                        navigationIcon = {
                            IconButton(onClick = { screen = Screen.Conversations }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.surface,
                        ),
                    )
                }
            }
        },
        floatingActionButton = {
            if (screen is Screen.Conversations) {
                androidx.compose.material3.ExtendedFloatingActionButton(
                    onClick = { screen = Screen.Chat(null, "新しい会話") },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Text("新しい会話")
                }
            }
        },
    ) { padding ->
        when (val current = screen) {
            is Screen.Chat -> {
                ChatScreen(
                    api = api,
                    settings = settings,
                    conversationId = current.conversationId,
                    initialTitle = current.title,
                    models = models,
                    modelsError = modelsError,
                    selectedModel = selectedModel,
                    reasoningLevel = reasoningLevel,
                    onReasoningChange = {
                        reasoningLevel = it
                        settings.reasoningLevel = it
                    },
                    onConversationCreated = { newId, newTitle ->
                        screen = Screen.Chat(newId, newTitle)
                        listVersion++
                    },
                    onBack = { listVersion++; screen = Screen.Conversations },
                    modifier = Modifier.padding(padding),
                )
            }
            Screen.Conversations -> {
                ConversationsScreen(
                    api = api,
                    version = listVersion,
                    onOpen = { conversation ->
                        screen = Screen.Chat(conversation.id, conversation.title)
                    },
                    onDeleted = { listVersion++ },
                    modifier = Modifier.padding(padding),
                )
            }
            Screen.Settings -> {
                SettingsScreen(
                    api = api,
                    settings = settings,
                    modifier = Modifier.padding(padding),
                )
            }
        }
    }
}
