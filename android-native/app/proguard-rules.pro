-keep class com.reedersystems.commandcomms.data.model.** { *; }
-keep class com.reedersystems.commandcomms.signaling.** { *; }

-keep class io.livekit.** { *; }
-dontwarn io.livekit.**

-keep class io.socket.** { *; }
-dontwarn io.socket.**

-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

-keep class okhttp3.** { *; }
-dontwarn okhttp3.**
