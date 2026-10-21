package top.helloac.mybooks.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

const val DEFAULT_BASE_URL = "https://helloac.top/"

data class AppSettings(
    val baseUrl: String = DEFAULT_BASE_URL,
    val themeMode: Int = 0,
)

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("mybooks-settings", Context.MODE_PRIVATE)
    private val _settings = MutableStateFlow(load())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    init {
        if (prefs.contains(KEY_LEGACY_TOKEN)) {
            prefs.edit().remove(KEY_LEGACY_TOKEN).apply()
        }
    }

    private fun load() = AppSettings(
        baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL,
        themeMode = prefs.getInt(KEY_THEME, 0),
    )

    fun save(value: AppSettings) {
        val normalized = value.copy(baseUrl = normalizeBaseUrl(value.baseUrl))
        prefs.edit()
            .putString(KEY_BASE_URL, normalized.baseUrl)
            .putInt(KEY_THEME, normalized.themeMode)
            .apply()
        _settings.value = normalized
    }

    fun saveThemeMode(mode: Int) {
        _settings.value = _settings.value.copy(themeMode = mode)
        prefs.edit().putInt(KEY_THEME, mode).apply()
    }

    fun lastUpdateCheck(): Long = prefs.getLong(KEY_LAST_UPDATE_CHECK, 0L)

    fun setLastUpdateCheck(millis: Long) {
        prefs.edit().putLong(KEY_LAST_UPDATE_CHECK, millis).apply()
    }

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_LEGACY_TOKEN = "admin_token"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_LAST_UPDATE_CHECK = "last_update_check"

        fun normalizeBaseUrl(raw: String): String {
            val trimmed = raw.trim().ifBlank { DEFAULT_BASE_URL }
            val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                trimmed
            } else {
                "https://$trimmed"
            }
            return withScheme.trimEnd('/') + "/"
        }
    }
}
