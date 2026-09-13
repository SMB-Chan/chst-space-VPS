package com.smbchan.chatspace

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.smbchan.chatspace.ui.ChatSpaceApp
import com.smbchan.chatspace.ui.theme.ChatSpaceTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ChatSpaceTheme {
                ChatSpaceApp()
            }
        }
    }
}
