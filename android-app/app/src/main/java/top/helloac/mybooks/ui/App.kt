package top.helloac.mybooks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import top.helloac.mybooks.data.AppContainer
import top.helloac.mybooks.ui.book.BookDetailScreen
import top.helloac.mybooks.ui.book.BookEditScreen
import top.helloac.mybooks.ui.main.MainScreen
import top.helloac.mybooks.ui.settings.SettingsScreen
import top.helloac.mybooks.ui.update.UpdateHost
import top.yukonga.miuix.kmp.nav.core.NavCornerClipMode
import top.yukonga.miuix.kmp.nav.core.NavDisplayEffects
import top.yukonga.miuix.kmp.nav.core.rememberNavController
import top.yukonga.miuix.kmp.nav.core.NavDisplay

@Composable
fun App(container: AppContainer) {
    val nav = rememberNavController<Route>(Route.Main)

    LaunchedEffect(Unit) {
        container.updateManager.checkOnLaunch()
    }

    Box(modifier = Modifier.fillMaxSize()) {
        NavDisplay(
            navController = nav,
            effects = NavDisplayEffects(
                enableCornerClip = true,
                cornerClipRadius = 24.dp,
                cornerClipMode = NavCornerClipMode.Leading,
                dimAmount = 0.32f,
            ),
        ) {
            entry<Route.Main> {
                MainScreen(
                    container = container,
                    onOpenBook = { nav.push(Route.BookDetail(it)) },
                    onAddBook = { nav.push(Route.BookEdit()) },
                    onSettings = { nav.push(Route.Settings) },
                )
            }
            entry<Route.BookDetail> { route ->
                BookDetailScreen(
                    container = container,
                    bookId = route.id,
                    onBack = { nav.pop() },
                    onEdit = { nav.push(Route.BookEdit(route.id)) },
                )
            }
            entry<Route.BookEdit> { route ->
                BookEditScreen(
                    container = container,
                    bookId = route.id,
                    onBack = { nav.pop() },
                    onSaved = { nav.pop() },
                )
            }
            entry<Route.Settings> {
                SettingsScreen(
                    container = container,
                    onBack = { nav.pop() },
                )
            }
        }

        UpdateHost(container.updateManager)
    }
}
