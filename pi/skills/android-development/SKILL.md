---
name: android-development
description: Android app development with Kotlin/Java, Jetpack Compose, Gradle build system, ADB debugging, and best practices. 手动执行 /skill:android-development 时加载。
disable-model-invocation: true
---

# Android 开发技能

Android 应用开发的完整指南，涵盖项目结构、Gradle 构建、Kotlin/Java 开发、Jetpack Compose 和 ADB 调试。

## 项目结构

标准 Android 项目结构：

```
project/
├── app/
│   ├── build.gradle.kts          # 应用级构建脚本
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/example/  # Kotlin/Java 源码
│   │   │   ├── res/               # 资源文件
│   │   │   │   ├── layout/        # XML 布局
│   │   │   │   ├── values/        # strings.xml, colors.xml, themes.xml
│   │   │   │   ├── drawable/      # 图片和矢量图
│   │   │   │   └── mipmap/        # 应用图标
│   │   │   └── AndroidManifest.xml # 应用清单
│   │   ├── test/                   # 单元测试
│   │   └── androidTest/           # 仪器化测试
├── build.gradle.kts               # 项目级构建脚本
├── settings.gradle.kts            # 项目设置
├── gradle/
│   └── libs.versions.toml         # 版本目录（推荐）
├── gradlew / gradlew.bat          # Gradle Wrapper
└── gradle.properties              # Gradle 属性
```

## Gradle 构建系统

### 常用命令

```bash
# 构建 APK（调试版）
./gradlew assembleDebug

# 构建 APK（发布版）
./gradlew assembleRelease

# 构建 AAB（Android App Bundle）
./gradlew bundleRelease

# 安装到设备
./gradlew installDebug

# 清理构建
./gradlew clean

# 运行测试
./gradlew test
./gradlew connectedAndroidTest

# 查看依赖树
./gradlew app:dependencies

# 更新 Gradle Wrapper
./gradlew wrapper --gradle-version=8.7

# 查看所有任务
./gradlew tasks --all

# Lint 检查
./gradlew lint
```

### 版本目录 (libs.versions.toml)

```toml
[versions]
kotlin = "2.0.0"
compose-bom = "2024.06.00"

[libraries]
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }

[plugins]
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
```

### 依赖管理常见问题

1. **依赖冲突**：`./gradlew app:dependencies` 查看依赖树，使用 `force` 或 `constraints` 解决
2. **缓存问题**：清除 Gradle 缓存 `rm -rf ~/.gradle/caches/`
3. **版本不兼容**：检查 `compileSdk`、`targetSdk`、`minSdk` 与依赖库兼容性
4. **重复类错误**：检查是否有库通过 `implementation` 和 `api` 重复引入

## Kotlin 开发要点

### 协程

```kotlin
// 在 ViewModel 中使用
class MyViewModel : ViewModel() {
    private val _state = MutableStateFlow<UiState>(UiState.Loading)
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun loadData() {
        viewModelScope.launch {
            _state.value = UiState.Loading
            try {
                val data = withContext(Dispatchers.IO) {
                    repository.fetchData()
                }
                _state.value = UiState.Success(data)
            } catch (e: Exception) {
                _state.value = UiState.Error(e.message)
            }
        }
    }
}
```

### 空安全与扩展函数

```kotlin
// 空安全操作符
val length = nullableString?.length ?: 0
nullableObject?.let { /* it 不为空 */ }

// 扩展函数（推荐用于工具类）
fun Context.showToast(message: String, duration: Int = Toast.LENGTH_SHORT) {
    Toast.makeText(this, message, duration).show()
}
```

### 密封类与 Result

```kotlin
sealed class UiState {
    data object Loading : UiState()
    data class Success(val data: List<Item>) : UiState()
    data class Error(val message: String?) : UiState()
}
```

## Jetpack Compose

### 基本组件

```kotlin
@Composable
fun MyScreen(viewModel: MyViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = { TopAppBar(title = { Text("标题") }) }
    ) { paddingValues ->
        when (val s = state) {
            is UiState.Loading -> LoadingIndicator()
            is UiState.Success -> ContentList(
                items = s.data,
                modifier = Modifier.padding(paddingValues)
            )
            is UiState.Error -> ErrorMessage(s.message)
        }
    }
}
```

### 导航

```kotlin
// 使用 Navigation Compose
NavHost(navController, startDestination = "home") {
    composable("home") { HomeScreen(navController) }
    composable("detail/{id}") { backStackEntry ->
        DetailScreen(id = backStackEntry.arguments?.getString("id"))
    }
}
```

### 主题与样式

```kotlin
MaterialTheme(
    colorScheme = lightColorScheme(
        primary = Color(0xFF6200EE),
        secondary = Color(0xFF03DAC5),
    ),
    typography = Typography(
        bodyLarge = TextStyle(fontSize = 16.sp)
    )
) {
    // 应用内容
}
```

## AndroidManifest.xml 常见配置

```xml
<!-- 权限 -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />

<!-- Activity 声明 -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:theme="@style/Theme.MyApp">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity>
```

## ADB 调试命令

```bash
# 设备管理
adb devices                       # 列出已连接设备
adb -s <serial> <command>        # 指定设备
adb kill-server / start-server   # 重启 ADB

# 安装与卸载
adb install app.apk               # 安装 APK
adb install -r app.apk            # 覆盖安装
adb uninstall <package>           # 卸载

# 日志
adb logcat                        # 查看所有日志
adb logcat -s TAG                 # 按标签过滤
adb logcat | grep "Error"         # 查找错误
adb logcat -c                     # 清除日志

# 文件操作
adb push <local> <remote>         # 上传文件
adb pull <remote> <local>         # 下载文件

# Shell 命令
adb shell                         # 进入设备 shell
adb shell am start -n <pkg>/<activity>   # 启动 Activity
adb shell input keyevent 26       # 电源键
adb shell dumpsys package <pkg>   # 查看应用信息

# 截图与录屏
adb exec-out screencap -p > screen.png    # 截图
adb shell screenrecord /sdcard/demo.mp4   # 录屏
```

## 常见问题诊断

### 构建失败

1. **检查 JDK 版本**：Android Gradle Plugin 8.x 需要 JDK 17+
   ```bash
   java -version
   ```

2. **Gradle sync 失败**：确认 `settings.gradle.kts` 中仓库配置
   ```kotlin
   dependencyResolutionManagement {
       repositories {
           google()
           mavenCentral()
       }
   }
   ```

3. **资源找不到**：确认 `R` 文件生成，清理重建 `./gradlew clean assembleDebug`

### 运行时崩溃

1. **ClassNotFoundException**：检查 ProGuard/R8 混淆规则 (`proguard-rules.pro`)
2. **NullPointerException**：检查视图绑定和空安全
3. **NetworkOnMainThreadException**：确保网络操作在后台线程
4. **SecurityException**：检查是否声明了所需权限

### 性能优化

- 使用 `RecyclerView` 而非 `ListView`
- Compose 中使用 `derivedStateOf` 和 `remember` 优化重组
- 图片加载使用 Coil 或 Glide
- 使用 Android Profiler 分析内存和 CPU

## API 级别兼容性

| 版本 | API 级别 | 关键特性 |
|------|---------|---------|
| Android 14 | 34 | 预测性返回手势 |
| Android 13 | 33 | 通知权限、每应用语言 |
| Android 12 | 31-32 | Material You、SplashScreen |
| Android 11 | 30 | 分区存储、一次性权限 |

## 常用库推荐

| 库 | 用途 |
|----|------|
| Hilt/Dagger | 依赖注入 |
| Retrofit + OkHttp | 网络请求 |
| Room | 本地数据库 |
| Coil | 图片加载 |
| Navigation Compose | 页面导航 |
| DataStore | 键值存储 |

## 安全检查清单

- [ ] `exported` 属性正确设置（接收外部 Intent 时才为 true）
- [ ] 敏感数据使用 EncryptedSharedPreferences 或 Keystore
- [ ] 网络请求使用 HTTPS
- [ ] `android:usesCleartextTraffic="false"`（生产环境）
- [ ] ProGuard/R8 已启用（release 构建）
- [ ] API 密钥不在代码中硬编码
