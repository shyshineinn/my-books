# Keep kotlinx.serialization generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class top.helloac.mybooks.** {
    *** Companion;
}
-keepclasseswithmembers class top.helloac.mybooks.** {
    kotlinx.serialization.KSerializer serializer(...);
}
