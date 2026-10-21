package top.helloac.mybooks

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import top.helloac.mybooks.ui.App
import top.helloac.mybooks.ui.theme.MyBooksTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as MyBooksApplication).container
        setContent {
            val settings by container.settingsStore.settings.collectAsState()
            MyBooksTheme(themeMode = settings.themeMode) {
                App(container = container)
            }
        }
    }
}
