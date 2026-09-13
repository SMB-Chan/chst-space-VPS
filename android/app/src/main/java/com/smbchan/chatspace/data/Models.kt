package com.smbchan.chatspace.data

import kotlinx.serialization.Serializable

@Serializable
data class Conversation(
    val id: Int,
    val title: String,
    val createdAt: String = "",
)

@Serializable
data class Source(
    val title: String,
    val url: String,
)

@Serializable
data class ChatMessage(
    val id: Int? = null,
    val role: String,
    val content: String,
    val modelId: String? = null,
    val sources: List<Source>? = null,
)

@Serializable
data class ConversationWithMessages(
    val id: Int,
    val title: String,
    val createdAt: String = "",
    val messages: List<ChatMessage> = emptyList(),
)

@Serializable
data class ModelInfo(
    val id: String,
    val label: String,
    val description: String? = null,
    val supportsVision: Boolean = false,
    val supportsReasoning: Boolean = false,
    val provider: String? = null,
)

@Serializable
data class ConversationInput(val title: String)

@Serializable
data class MessageInput(
    val content: String,
    val modelId: String? = null,
)
