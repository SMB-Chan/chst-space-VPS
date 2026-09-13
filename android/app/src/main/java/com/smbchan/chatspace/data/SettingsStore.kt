package com.smbchan.chatspace.data

import android.content.Context
import android.content.SharedPreferences

/** アプリ設定 (サーバーURL・モデル・推論・監査・翻訳・バイブ) の永続化。 */
class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("chat_space_settings", Context.MODE_PRIVATE)

    companion object {
        const val DEFAULT_SERVER_URL = "https://sakura-dev.tailcf5af9.ts.net:8443"
        val REASONING_LEVELS = listOf("off", "low", "medium", "high")

        val TRANSLATION_MODES = listOf(
            "off" to "翻訳: オフ",
            "auto" to "翻訳: 自動(日⇄英)",
            "ja-en" to "翻訳: 日→英",
            "en-ja" to "翻訳: 英→日",
            "auto-ko" to "翻訳: 自動(日⇄韓)",
            "ja-ko" to "翻訳: 日→韓",
            "ko-ja" to "翻訳: 韓→日",
            "auto-zh" to "翻訳: 自動(日⇄中)",
            "ja-zh" to "翻訳: 日→中",
            "zh-ja" to "翻訳: 中→日",
        )
    }

    var serverUrl: String
        get() {
            val stored = prefs.getString("server_url", null)?.takeIf { it.isNotBlank() }
            return (stored ?: DEFAULT_SERVER_URL).trimEnd('/')
        }
        set(value) = prefs.edit().putString("server_url", value.trim().trimEnd('/')).apply()

    var selectedModel: String
        get() = prefs.getString("selected_model", null) ?: ""
        set(value) = prefs.edit().putString("selected_model", value).apply()

    var reasoningLevel: String
        get() = prefs.getString("reasoning_level", null) ?: "medium"
        set(value) = prefs.edit().putString("reasoning_level", value).apply()

    var auditEnabled: Boolean
        get() = prefs.getBoolean("audit_enabled", false)
        set(value) = prefs.edit().putBoolean("audit_enabled", value).apply()

    var translationMode: String
        get() = prefs.getString("translation_mode", null) ?: "off"
        set(value) = prefs.edit().putString("translation_mode", value).apply()

    var hapticsEnabled: Boolean
        get() = prefs.getBoolean("haptics_enabled", true)
        set(value) = prefs.edit().putBoolean("haptics_enabled", value).apply()
}
