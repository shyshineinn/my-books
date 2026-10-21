pluginManagement {
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "my-books-android"
include(":app")

// 本地有 miuix-0.9.4 源码时默认用它；没有时自动使用 Maven Central 的 0.9.4 构件。
// 可用 -PuseLocalMiuix=true/false 强制切换。
val localMiuixDir = file("../miuix-0.9.4")
val useLocalMiuix = providers.gradleProperty("useLocalMiuix")
    .map { it.toBoolean() }
    .getOrElse(localMiuixDir.isDirectory)

if (useLocalMiuix) {
    require(localMiuixDir.isDirectory) {
        "本地 Miuix 源码不存在：${localMiuixDir.absolutePath}；请放入 0.9.4 源码，或传 -PuseLocalMiuix=false"
    }
    includeBuild(localMiuixDir.path) {
        dependencySubstitution {
            substitute(module("top.yukonga.miuix.kmp:miuix-ui")).using(project(":miuix-ui"))
            substitute(module("top.yukonga.miuix.kmp:miuix-preference")).using(project(":miuix-preference"))
            substitute(module("top.yukonga.miuix.kmp:miuix-icons")).using(project(":miuix-icons"))
            substitute(module("top.yukonga.miuix.kmp:miuix-nav")).using(project(":miuix-nav"))
            substitute(module("top.yukonga.miuix.kmp:miuix-squircle")).using(project(":miuix-squircle"))
        }
    }
}
