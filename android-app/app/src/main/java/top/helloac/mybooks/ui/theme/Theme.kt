package top.helloac.mybooks.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.theme.ColorSchemeMode
import top.yukonga.miuix.kmp.theme.MiuixTheme
import top.yukonga.miuix.kmp.theme.ThemeController

@Composable
fun MyBooksTheme(themeMode: Int, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val dark = when (themeMode) {
        1 -> false
        2 -> true
        else -> systemDark
    }
    val controller = remember(themeMode, dark) {
        ThemeController(
            colorSchemeMode = when (themeMode) {
                1 -> ColorSchemeMode.Light
                2 -> ColorSchemeMode.Dark
                else -> ColorSchemeMode.System
            },
            isDark = dark,
        )
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = view.context.findActivity()?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    MiuixTheme(controller = controller) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MiuixTheme.colorScheme.background,
            contentColor = MiuixTheme.colorScheme.onBackground,
        ) {
            content()
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
