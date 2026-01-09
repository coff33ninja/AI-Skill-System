# AI Skill System - Future Roadmap

## ✅ Completed (v1.0)

### Core Tools (119 total)
- [x] Control permission system (enable/disable/status)
- [x] Screen capture (screenshot, region capture, color analysis, dominant colors)
- [x] Screen info (multi-monitor support)
- [x] Mouse: move, click, double-click, triple-click, scroll, drag, hold, position, smooth move, relative move
- [x] Keyboard: type, shortcut, press single key, hold modifier, slow type, combo
- [x] Clipboard: read/write, text operations (copy/cut/paste/undo/redo/select all)
- [x] Window: active window info, list all windows, focus, resize, move, minimize, maximize, restore, close, snap
- [x] Utility: wait/pause, screen highlight
- [x] OCR: find text, wait for text, read all text, click text
- [x] Image matching: find image, wait for image
- [x] System: app launch/close, file/folder/URL open, volume control, notifications, process list/kill
- [x] Macros: record, stop, play, list, delete
- [x] Safety: action history, undo, safe zones, rate limiting
- [x] Windows: search, run, lock, snip, task manager, settings, action center, emoji picker, brightness
- [x] UI Automation: element at point, element tree, find elements, click by name/ID
- [x] Android (ADB): devices, tap, swipe, type, key, screenshot, shell, app launch/list
- [x] Browser (CDP): open, tabs, navigate, click, type, screenshot, eval, scroll, get text/html, wait for
- [x] AI Helpers: screen describe, find clickables, action suggest, error recovery, wait for change, compare, context save/restore

### Voice Mode
- [x] Gemini Live API integration (TTS/STT)
- [x] Mic capture with pause/resume (prevent feedback)
- [x] Audio buffering for smooth playback
- [x] Tool calling in voice mode
- [x] Skill recording in voice mode

### Skill System
- [x] Skill recording and storage
- [x] Drift tracking (confidence/speed/complexity trends)
- [x] Pre-seeded skills (30 cross-platform shortcuts)
- [x] Skill query tools (list, search, drift analysis)

---

## 🔮 Future Enhancements

### Phase 1: Image Recognition (nut-js plugins)
- [x] `screen_find_image` - Find image/icon on screen by template matching (pixelmatch)
- [x] `screen_wait_for_image` - Wait until image appears on screen
- [x] `screen_click_text` - OCR to find text and click on it
- [x] `screen_find_text` - OCR to find text on screen (tesseract.js)
- [x] `screen_wait_for_text` - Wait until text appears on screen
- [x] `screen_read_all_text` - OCR entire screen or region
- [x] `screen_region_capture` - Capture specific region only
- [x] `screen_color_at` - Get pixel color at coordinates

### Phase 2: Advanced Window Management
- [x] `window_focus` - Focus/activate window by title
- [x] `window_minimize` - Minimize window
- [x] `window_maximize` - Maximize window
- [x] `window_restore` - Restore minimized window
- [x] `window_close` - Close window
- [x] `window_resize` - Resize window to dimensions
- [x] `window_move` - Move window to position
- [x] `window_snap` - Snap window to screen edge (left/right/top/bottom/corners)

### Phase 3: System Integration
- [x] `app_launch` - Launch application by name/path
- [x] `app_close` - Close application by name
- [x] `app_list` - List running applications (via process_list)
- [x] `file_open` - Open file with default application
- [x] `folder_open` - Open folder in file manager
- [x] `url_open` - Open URL in default browser
- [x] `notification_show` - Show system notification
- [x] `volume_set` - Set system volume
- [x] `volume_mute` - Mute/unmute system audio
- [x] `volume_get` - Get current volume level

### Phase 4: Context Awareness
- [x] `screen_color_at` - Get pixel color at coordinates
- [x] `screen_dominant_colors` - Get dominant colors in region
- [x] `ui_element_at` - Get UI element info at coordinates (Windows UI Automation)
- [x] `ui_element_tree` - Get UI element hierarchy of active window
- [x] `ui_element_find` - Find UI elements by name/type/automationId
- [x] `ui_element_click` - Click UI element by name or automation ID
- [x] `process_list` - List running processes
- [x] `process_kill` - Kill process by name/PID
- [x] `screen_text_read` - Capture region for AI vision OCR

### Phase 5: Advanced Input
- [x] `mouse_smooth_move` - Move mouse along curved path (human-like)
- [x] `mouse_move_relative` - Move mouse relative to current position
- [x] `mouse_click_at` - Move to coordinates and click in one action
- [x] `keyboard_type_slow` - Type with human-like delays
- [x] `keyboard_combo` - Execute sequence of keys with delays
- [x] `text_select_all` - Select all text (Ctrl+A)
- [x] `text_paste` - Paste from clipboard (Ctrl+V)
- [x] `text_copy` - Copy to clipboard (Ctrl+C)
- [x] `text_cut` - Cut to clipboard (Ctrl+X)
- [x] `text_undo` - Undo (Ctrl+Z)
- [x] `text_redo` - Redo (Ctrl+Y)
- [ ] `gesture_pinch` - Pinch gesture (touchpad/touchscreen)
- [ ] `gesture_swipe` - Swipe gesture
- [ ] `gamepad_input` - Game controller input simulation

### Phase 6: Recording & Playback
- [x] `macro_record_start` - Start recording user actions
- [x] `macro_record_stop` - Stop recording and save macro
- [x] `macro_play` - Play recorded macro
- [x] `macro_list` - List saved macros
- [x] `macro_delete` - Delete macro

### Phase 7: Multi-Device & Remote
- [x] `adb_devices` - List connected Android devices
- [x] `adb_tap` - Tap on Android screen
- [x] `adb_swipe` - Swipe on Android screen
- [x] `adb_type` - Type text on Android
- [x] `adb_key` - Press key on Android (home, back, menu, etc.)
- [x] `adb_screenshot` - Take Android screenshot
- [x] `adb_shell` - Run shell command on Android
- [x] `adb_app_launch` - Launch Android app by package
- [x] `adb_app_list` - List installed Android apps
- [x] `browser_open` - Open Chrome with remote debugging
- [x] `browser_tabs` - List open browser tabs
- [x] `browser_navigate` - Navigate to URL
- [x] `browser_click` - Click element by CSS selector
- [x] `browser_type` - Type into input field
- [x] `browser_screenshot` - Take browser screenshot
- [x] `browser_eval` - Execute JavaScript
- [x] `browser_scroll` - Scroll page
- [x] `browser_get_text` - Get element text
- [x] `browser_get_html` - Get page/element HTML
- [x] `browser_wait_for` - Wait for element to appear
- [ ] Mesh network improvements (auto-discovery, encryption)
- [ ] Remote screen streaming
- [ ] Multi-device orchestration (control multiple computers)

### Phase 8: AI Enhancements
- [x] `screen_describe` - Get structured description of screen state
- [x] `screen_find_clickable` - Find clickable elements via OCR
- [x] `action_suggest` - Get suggestions for next actions based on goal
- [x] `error_recover` - Analyze failures and suggest recovery steps
- [x] `screen_wait_for_change` - Wait until screen content changes
- [x] `screen_compare` - Compare current screen with previous screenshot
- [x] `context_save` - Save current context (mouse, window) for later
- [x] `context_restore` - Restore a saved context
- [x] `context_list` - List saved context snapshots
- [ ] Natural language to coordinates ("click the red button") - requires vision model
- [ ] Skill generalization (adapt learned skills to similar tasks)
- [ ] Proactive suggestions based on context

### Phase 9: Safety & Accessibility
- [x] `action_history` - Get history of recent actions (audit log)
- [x] `action_undo_last` - Undo last action (Ctrl+Z)
- [x] `safe_zone_add` - Add protected screen region
- [x] `safe_zone_remove` - Remove safe zone
- [x] `safe_zone_list` - List all safe zones
- [x] `rate_limit_set` - Set max actions per second
- [ ] Action preview mode (show what will happen before doing it)
- [ ] Voice confirmation for destructive actions
- [ ] Screen reader integration
- [ ] High contrast mode detection

### Phase 10: Platform-Specific
- [x] Windows: `windows_search` - Search via Start menu
- [x] Windows: `windows_run` - Run dialog command
- [x] Windows: `windows_lock` - Lock workstation
- [x] Windows: `windows_screenshot_snip` - Snipping Tool
- [x] Windows: `windows_task_manager` - Open Task Manager
- [x] Windows: `windows_settings` - Open Settings
- [x] Windows: `windows_action_center` - Open Action Center
- [x] Windows: `windows_emoji_picker` - Open emoji picker
- [x] Windows: `display_brightness_get/set` - Brightness control
- [ ] Windows: Registry access
- [ ] macOS: AppleScript integration, Spotlight, Notification Center
- [ ] Linux: D-Bus integration, desktop environment detection
- [ ] Cross-platform file path normalization

---

## 🛠 Technical Debt
- [ ] Add comprehensive error handling for all tools
- [ ] Add input validation for all tool parameters
- [ ] Add retry logic for flaky operations
- [ ] Add telemetry/metrics for tool usage
- [ ] Add unit tests for MCP server
- [ ] Add integration tests for voice mode
- [ ] Optimize screenshot compression
- [ ] Add WebSocket reconnection logic for Live API

---

## 📦 Dependencies to Consider
- `@nut-tree/plugin-ocr` - OCR/text recognition
- `@nut-tree/nl-matcher` - Natural language image matching
- `node-window-manager` - Advanced window management
- `open` - Cross-platform app/file/URL opening
- `loudness` - System volume control
- `node-notifier` - System notifications
- `playwright` - Browser automation
- `sharp` - Image processing for screenshots

---

## 🎯 Version Milestones

### v1.1 - Image Recognition
Focus: Find and interact with UI elements by appearance

### v1.2 - Window Management
Focus: Full window control and multi-monitor support

### v1.3 - System Integration
Focus: Launch apps, open files, system controls

### v1.4 - Recording & Macros
Focus: Record and replay user actions

### v2.0 - Vision AI
Focus: Natural language screen understanding

---

*Last updated: January 2026*
