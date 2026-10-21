package top.helloac.mybooks.ui

import kotlinx.serialization.Serializable
import top.yukonga.miuix.kmp.nav.core.NavKey

@Serializable
sealed interface Route : NavKey {
    @Serializable
    data object Main : Route

    @Serializable
    data class BookDetail(val id: Int) : Route

    @Serializable
    data class BookEdit(val id: Int? = null) : Route

    @Serializable
    data object Settings : Route
}
