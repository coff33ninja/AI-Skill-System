# AI Skill System - Future Roadmap

## ✅ Completed (v1.0)

### Core Tools (26 total)
- [x] Control permission system (enable/disable/status)
- [x] Screen capture (screenshot)
- [x] Screen info (multi-monitor support)
- [x] Mouse: move, click, double-click, triple-click, scroll, drag, hold, position
- [x] Keyboard: type, shortcut, press single key, hold modifier
- [x] Clipboard: read/write
- [x] Window: active window info, list all windows
- [x] Utility: wait/pause, screen highlight

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
- [ ] `screen_find_image` - Find image/icon on screen by template matching (needs @nut-tree/nl-matcher)
- [ ] `screen_find_text` - OCR to find text on screen (needs @nut-tree/plugin-ocr)
- [ ] `screen_wait_for` - Wait until image/text appears on screen
- [ ] `screen_find_all` - Find all instances of image/text
- [x] `screen_region_capture` - Capture specific region only
- [x] `screen_color_at` - Get pixel color at coordinates

### Phase 2: Advanced Window Management
- [x] `window_focus` - Focus/activate window by title
- [ ] `window_minimize` - Minimize window
- [ ] `window_maximize` - Maximize window
- [ ] `window_restore` - Restore minimized window
- [ ] `window_close` - Close window
- [x] `window_resize` - Resize window to dimensions
- [x] `window_move` - Move window to position
- [ ] `window_snap` - Snap window to screen edge (left/right/top/bottom)

### Phase 3: System Integration
- [x] `app_launch` - Launch application by name/path
- [ ] `app_close` - Close application
- [ ] `app_list` - List running applications
- [x] `file_open` - Open file with default application
- [x] `folder_open` - Open folder in file manager
- [x] `url_open` - Open URL in default browser
- [ ] `notification_show` - Show system notification
- [ ] `volume_set` - Set system volume
- [ ] `volume_mute` - Mute/unmute system audio

### Phase 4: Context Awareness
- [ ] `screen_color_at` - Get pixel color at coordinates
- [ ] `screen_dominant_colors` - Get dominant colors in region
- [ ] `ui_element_at` - Get UI element info at coordinates (accessibility APIs)
- [ ] `ui_element_tree` - Get UI element hierarchy of active window
- [ ] `ui_element_click` - Click UI element by accessibility label
- [ ] `process_list` - List running processes
- [ ] `process_kill` - Kill process by name/PID

### Phase 5: Advanced Input
- [ ] `mouse_smooth_move` - Move mouse along curved path (human-like)
- [ ] `keyboard_type_slow` - Type with human-like delays
- [ ] `gesture_pinch` - Pinch gesture (touchpad/touchscreen)
- [ ] `gesture_swipe` - Swipe gesture
- [ ] `gamepad_input` - Game controller input simulation

### Phase 6: Recording & Playback
- [ ] `macro_record_start` - Start recording user actions
- [ ] `macro_record_stop` - Stop recording and save macro
- [ ] `macro_play` - Play recorded macro
- [ ] `macro_list` - List saved macros
- [ ] `macro_delete` - Delete macro

### Phase 7: Multi-Device & Remote
- [ ] Mesh network improvements (auto-discovery, encryption)
- [ ] Remote screen streaming
- [ ] Multi-device orchestration (control multiple computers)
- [ ] Mobile device integration (ADB for Android)
- [ ] Browser automation bridge (Playwright/Puppeteer integration)

### Phase 8: AI Enhancements
- [ ] Vision model integration (describe what's on screen)
- [ ] Intent prediction (suggest next action)
- [ ] Error recovery (auto-retry with different approach)
- [ ] Natural language to coordinates ("click the red button")
- [ ] Skill generalization (adapt learned skills to similar tasks)
- [ ] Proactive suggestions based on context

### Phase 9: Safety & Accessibility
- [ ] Action preview mode (show what will happen before doing it)
- [ ] Undo system (reverse last N actions)
- [ ] Safe zones (regions AI cannot interact with)
- [ ] Rate limiting (max actions per second)
- [ ] Audit logging (detailed action history)
- [ ] Voice confirmation for destructive actions
- [ ] Screen reader integration
- [ ] High contrast mode detection

### Phase 10: Platform-Specific
- [ ] Windows: PowerShell integration, Registry access, Windows Search
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
