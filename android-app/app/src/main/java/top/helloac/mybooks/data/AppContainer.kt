package top.helloac.mybooks.data

import android.content.Context

class AppContainer(context: Context) {
    val settingsStore = SettingsStore(context)
    private val apiClient = ApiClient(settingsStore)
    val repository = BooksRepository(settingsStore, apiClient.api)
    val updateManager = UpdateManager(context.applicationContext, settingsStore, apiClient.api)
}
