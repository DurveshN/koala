# Elevated Installer - Quick Reference Card

**Status**: ✅ IMPLEMENTED  
**Date**: 2026-09-24

---

## 📋 What Changed

| File | Change | Impact |
|------|--------|---------|
| `packages/desktop/installer-setup.nsh` | **NEW** | Runs sandbox setup during install |
| `packages/desktop/electron-builder.config.ts` | `perMachine: true` | **Requests UAC elevation** |
| `packages/desktop/electron-builder.config.ts` | `include: "installer-setup.nsh"` | Includes NSIS script |

---

## 🔑 Key Changes in electron-builder.config.ts

```typescript
nsis: {
  oneClick: false,              // Changed from: true
  perMachine: true,             // Changed from: false ⚠️ REQUESTS ADMIN
  include: "installer-setup.nsh", // NEW: Runs sandbox setup
  // ... other settings
}
```

**⚠️ Critical**: `perMachine: true` triggers Windows UAC prompt

---

## 🚀 What Happens During Install

```
1. User runs koala-desktop-win-x64.exe
2. Windows UAC: "Allow this app to make changes?"
3. User clicks "Yes" → Installer gets admin privileges
4. Files copied to Program Files
5. NSIS runs: srt-win.exe install
   ├─ Creates srt-sandbox user
   ├─ Configures WFP filters
   └─ Sets up ACLs
6. App launches with sandbox working
```

---

## ✅ Success Indicators

After installation, verify:

```powershell
# 1. Sandbox user exists
Get-LocalUser -Name "srt-sandbox"
# Should show: srt-sandbox user

# 2. App runs with sandbox
# (Check in Koala settings UI when implemented)
```

---

## 🔧 Build Commands

```bash
# Development
cd packages/desktop
bun run build:win

# Production
export OPENCODE_CHANNEL=prod
export OPENCODE_RELEASE=1
cd packages/desktop
bun run build:win
```

**Output**: `packages/desktop/dist/koala-desktop-win-x64.exe`

---

## 🐛 Troubleshooting Quick Fixes

### UAC Prompt Declined
**Symptom**: Installation aborts  
**Fix**: Re-run installer, approve UAC

### Sandbox Setup Failed
**Symptom**: "Warning: Sandbox setup failed" in installer  
**Result**: App still works in host mode  
**Fix**: Check `.subagent/elevated-installer-implementation.md` troubleshooting section

### Sandbox User Not Created
**Check**:
```powershell
Get-LocalUser -Name "srt-sandbox"
```

**Manual Fix**:
```powershell
cd "C:\Program Files\Koala\resources\sandbox-runtime\vendor\srt-win\x64"
.\srt-win.exe install
```

---

## 📚 Full Documentation

- **Complete Guide**: [elevated-installer-implementation.md](./elevated-installer-implementation.md)
- **Task Summary**: [TASK-5-COMPLETE.md](./TASK-5-COMPLETE.md)
- **Strategy**: [PRODUCTION-SANDBOX-STRATEGY.md](./PRODUCTION-SANDBOX-STRATEGY.md)

---

## ⚠️ Important Notes

1. **UAC Prompt is Expected**: This is normal for system-level installers
2. **Failure is OK**: If sandbox setup fails, app works in host mode
3. **Signed Installer Recommended**: Reduces antivirus false positives
4. **Test on Clean VM**: Before production release

---

## 🎯 Quick Test (After Building)

1. Build installer
2. Copy to clean Windows VM
3. Run installer
4. Approve UAC
5. Check: `Get-LocalUser -Name "srt-sandbox"`
6. Launch Koala
7. Verify document tools work
8. Uninstall
9. Verify: `Get-LocalUser -Name "srt-sandbox"` (should error)

---

**Last Updated**: 2026-09-24  
**For Questions**: See [elevated-installer-implementation.md](./elevated-installer-implementation.md)
