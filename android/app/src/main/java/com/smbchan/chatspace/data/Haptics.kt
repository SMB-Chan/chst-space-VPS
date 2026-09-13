package com.smbchan.chatspace.data

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 生成中の触覚フィードバック。
 * - tick: 送信時・フェーズ変化時の短い振動
 * - done: 回答完了の長めの振動
 * - error: エラーの二段振動
 */
class Haptics(
    private val context: Context,
    private val enabled: () -> Boolean = { true },
) {

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    private fun oneShot(ms: Long) {
        if (!enabled()) return
        val v = vibrator() ?: return
        if (!v.hasVibrator()) return
        v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
    }

    private fun waveform(pattern: LongArray) {
        if (!enabled()) return
        val v = vibrator() ?: return
        if (!v.hasVibrator()) return
        v.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }

    fun tick() = oneShot(18L)

    fun phaseChange() = oneShot(12L)

    fun done() = oneShot(180L)

    fun error() = waveform(longArrayOf(0, 80, 90, 220))
}
