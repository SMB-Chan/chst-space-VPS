package com.smbchan.chatspace.data

import android.content.Context
import android.content.SharedPreferences

/** アプリ設定 (サーバーURL・モデル・推論レベル) の永続化。 */
class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("chat_space_settings", Context.MODE_PRIVATE)

    companion object {
        const val DEFAULT_SERVER_URL = "https://sakura-dev.tailcf5af9.ts.net:8443"
        val REASONING_LEVELS = listOf("off", "low", "medium", "high")
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
}
