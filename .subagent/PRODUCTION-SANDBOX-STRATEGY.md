# Production Sandbox Strategy - When Users Install the .exe

**Question**: In production, users won't run `npx sandbox-runtime windows-install` manually. How will sandbox work?

**Answer**: You need to handle sandbox setup during installation or use a different architecture.

---

## The Production Problem

### Current Situation (Development)
```
Developer:
1. Installs Node/Bun
2. Runs: bun install
3. Manually runs: npx sandbox-runtime windows-install
4. Sandbox works ✅
```

### Future Situation (Production)
```
End User:
1. Downloads Koala.exe
2. Runs installer
3. Koala installs
4. User runs Koala
5. Sandbox... ❌ NOT configured
```

**The Gap**: The sandbox user account and WFP filters are NOT automatically created during normal .exe installation.

---

## Why This is a Problem

### What the Current NSIS Installer Does

From `electron-builder.config.ts`:

```typescript
nsis: {
  oneClick: true,
  perMachine: false,
  installerIcon: `resources/icons/icon.ico`,
  installerHeaderIcon: `resources/icons/icon.ico`,
}
```

**Current installer:**
- ✅ Copies application files
- ✅ Creates shortcuts
- ✅ Registers app in Programs & Features
- ✅ Sets up file associations
- ❌ **Does NOT create sandbox user**
- ❌ **Does NOT configure WFP**

### Why Not?

Creating a Windows user account and configuring WFP requires:
1. **Administrator privileges** (UAC elevation)
2. **System-level changes**
3. **Security permissions**

NSIS installers CAN request elevation, but:
- `perMachine: false` means "install for current user only" (no elevation)
- Even with elevation, running arbitrary setup scripts is complex
- Users are wary of installers that ask for admin rights

---

## Solutions for Production

### Option 1: Request Elevation During Install (Full Sandbox)

**Change installer to require admin and set up sandbox**

#### Implementation

1. **Modify electron-builder config:**
```typescript
nsis: {
  oneClick: false,  // Allow customization
  perMachine: true,  // Require elevation
  runAfterFinish: false,  // Don't auto-run
  installerIcon: `resources/icons/icon.ico`,
  installerHeaderIcon: `resources/icons/icon.ico`,
  // Add custom NSIS script
  include: "installer-setup.nsh",
}
```

2. **Create `installer-setup.nsh`:**
```nsis
; After files are copied, run sandbox setup
!macro customInstall
  DetailPrint "Setting up secure sandbox..."
  
  ; Path to srt-win.exe in installed location
  nsExec::ExecToLog '"$INSTDIR\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe" install'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Warning: Sandbox setup failed. Some features may be limited."
  ${EndIf}
!macroend
```

3. **Handle failure gracefully:**
- Sandbox setup might fail (firewall, antivirus, policy)
- App should still run
- Fallback to host execution
- Show warning to user

#### Pros
- ✅ Fully automated
- ✅ Sandbox works out of the box
- ✅ No manual steps
- ✅ Best security

#### Cons
- ❌ Requires admin privileges
- ❌ Users see UAC prompt (scary)
- ❌ Corporate policies might block
- ❌ Antivirus might flag
- ❌ More complex installer
- ❌ Increases installation friction

---

### Option 2: First-Run Setup Dialog (Delayed Elevation)

**Ask for sandbox setup on first run, not during install**

#### Implementation

1. **Install without elevation**
   - Normal user-level install
   - No UAC prompt during install
   - Everything copied but sandbox not configured

2. **On first launch:**
```typescript
// In main process
async function checkSandboxStatus() {
  const status = await SandboxWorker.availability()
  
  if (status.availability.status === "unavailable" && 
      status.availability.reason === "initialization-failed") {
    
    // Show dialog to user
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Enable Secure Sandbox?",
      message: "Koala can run code in a secure sandbox for better isolation.",
      detail: "This requires a one-time setup with administrator privileges.\n\n" +
              "The sandbox provides:\n" +
              "• Isolated code execution\n" +
              "• Network filtering\n" +
              "• File system restrictions\n\n" +
              "Would you like to set this up now?",
      buttons: ["Set Up Now", "Skip for Now", "Don't Ask Again"],
      defaultId: 0,
      cancelId: 1,
    })
    
    if (result.response === 0) {
      // User chose "Set Up Now"
      await runSandboxSetup()
    } else if (result.response === 2) {
      // Don't ask again - save preference
      store.set("sandbox.skipSetup", true)
    }
  }
}

async function runSandboxSetup() {
  try {
    // Run srt-win.exe install with elevation
    const { shell } = await import("electron")
    const srtPath = path.join(process.resourcesPath, "sandbox-runtime", "vendor", "srt-win", "x64", "srt-win.exe")
    
    // This triggers UAC
    await shell.openExternal(`file://${srtPath}`, { 
      activate: true,
      // Note: We'd need to pass "install" argument somehow
    })
    
    // After setup, restart app
    app.relaunch()
    app.exit()
  } catch (error) {
    dialog.showErrorBox("Setup Failed", "Could not configure sandbox. App will use host execution mode.")
  }
}
```

#### Pros
- ✅ No UAC during install (lower friction)
- ✅ User understands why elevation needed
- ✅ Can skip if desired
- ✅ Gives user control

#### Cons
- ❌ Extra step after install
- ❌ Requires app restart
- ❌ Complicates first-run experience
- ❌ Users might skip and get degraded experience

---

### Option 3: Use Host Execution by Default (No Sandbox)

**Ship without sandboxing, document it as enterprise/advanced feature**

#### Implementation

1. **Default configuration:**
```typescript
// sidecar-env.ts
env.KOALA_AGENT_EXECUTION = "host"  // Default to host
```

2. **Document sandbox as advanced feature:**
```markdown
# Advanced: Enable Sandbox Mode

For enhanced security, Koala supports sandboxed code execution.

## Requirements
- Windows 10/11
- Administrator privileges (one-time setup)

## Setup
1. Open PowerShell as Administrator
2. Navigate to Koala installation:
   cd "C:\Users\[User]\AppData\Local\Programs\Koala"
3. Run: .\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe install
4. Restart Koala

## After Setup
Sandboxed execution provides:
- Process isolation
- Network filtering  
- Filesystem restrictions
```

3. **Add UI toggle:**
```typescript
// Settings panel
<Setting>
  <Label>Execution Mode</Label>
  <RadioGroup value={executionMode} onChange={setExecutionMode}>
    <Radio value="host">
      Host (Default)
      <Detail>Code runs directly on your system</Detail>
    </Radio>
    <Radio value="sandbox" disabled={!sandboxAvailable}>
      Sandbox {!sandboxAvailable && "(Requires setup)"}
      <Detail>Isolated execution with security boundaries</Detail>
    </Radio>
  </RadioGroup>
  {!sandboxAvailable && (
    <Button onClick={showSandboxSetupInstructions}>
      How to enable sandbox
    </Button>
  )}
</Setting>
```

#### Pros
- ✅ Zero installation friction
- ✅ No UAC prompts
- ✅ No admin required
- ✅ Fully functional immediately
- ✅ Simple, predictable behavior
- ✅ Works in restricted environments

#### Cons
- ❌ No isolation by default
- ❌ Less secure
- ❌ Code runs as user
- ❌ Most users won't enable sandbox
- ❌ Advanced feature becomes "hidden"

---

### Option 4: Hybrid Approach (Graceful Degradation)

**Try sandbox, fallback to host, notify user**

#### Implementation

```typescript
// At startup
async function determineExecutionMode() {
  const sandboxStatus = await SandboxWorker.availability()
  
  if (sandboxStatus.availability.status === "available") {
    // Sandbox works!
    return "sandbox"
  }
  
  // Sandbox not available
  if (shouldPromptForSetup()) {
    const setup = await promptSandboxSetup()
    if (setup === "now") {
      await runSandboxSetup()
      return "sandbox"  // After restart
    } else if (setup === "later") {
      // Remind next time
      return "host"
    } else {
      // Don't ask again
      savePreference("sandbox.dontPrompt", true)
      return "host"
    }
  }
  
  // Use host mode
  return "host"
}

// Show non-intrusive notification
function notifyExecutionMode(mode: "host" | "sandbox") {
  if (mode === "host") {
    // Show in status bar or first-run
    showNotification({
      type: "info",
      message: "Running in host mode. For enhanced security, enable sandbox mode in settings.",
      action: {
        label: "Learn More",
        onClick: () => openSandboxHelp()
      }
    })
  }
}
```

#### Pros
- ✅ Works immediately (no friction)
- ✅ Sandbox used when available
- ✅ Graceful fallback
- ✅ User can enable later
- ✅ Non-intrusive

#### Cons
- ❌ Most users stay on host mode
- ❌ Security varies per user
- ❌ Complicates support (different configs)

---

## Recommended Approach for Koala

### Phase 1: Launch (MVP)
**Use Option 3: Host Execution by Default**

**Rationale:**
- Koala is "sovereign" AI workbench
- Users installing it are trusted (it's their machine)
- Focusing on functionality over sandboxing
- Document tools work perfectly without sandbox
- Simpler deployment and support

**Implementation:**
```typescript
// sidecar-env.ts
env.KOALA_AGENT_EXECUTION = "host"
env.KOALA_ENABLE_DOCUMENT_TOOLS = "1"
```

**Documentation:**
- Clear README: "Sandbox mode available as advanced feature"
- Setup guide for enterprise/security-conscious users
- Settings UI shows current mode

### Phase 2: Post-Launch
**Add Option 2: First-Run Dialog (Optional)**

When users are comfortable with the product:
- Add first-run sandbox prompt
- Make it optional
- Clear value proposition
- Easy to skip

### Phase 3: Enterprise
**Offer Option 1: Elevated Install (Enterprise Version)**

For corporate deployments:
- Separate enterprise installer
- Requires admin (expected in corporate)
- Full sandbox by default
- Group policy support

---

## Comparison Matrix

| Approach | Install Friction | Security | User Control | Support Complexity |
|----------|-----------------|----------|--------------|-------------------|
| **Elevated Install** | High (UAC) | Best | Low | Low |
| **First-Run Setup** | Low | Good | High | Medium |
| **Host Default** | None | Basic | High | Low |
| **Hybrid** | None | Variable | High | High |

---

## What Other Apps Do

### VS Code
- **No sandbox** for extensions
- Extensions run in same process
- Trust model: curated marketplace

### Docker Desktop
- **Requires admin** during install
- Creates virtual machine
- Users expect elevated install

### Postman
- **No sandbox** by default
- Code runs as user
- Enterprise version has more controls

### IntelliJ IDEA
- **No process sandbox**
- JVM-level isolation only
- Trusted code model

---

## Implementation Checklist

### For Host Mode Default (Recommended for Launch)

- [x] Set `KOALA_AGENT_EXECUTION = "host"` in sidecar-env.ts
- [x] Keep `KOALA_ENABLE_DOCUMENT_TOOLS = "1"`
- [ ] Add settings UI to show execution mode
- [ ] Document sandbox as advanced feature
- [ ] Create setup guide for sandbox
- [ ] Test installer doesn't require elevation
- [ ] Verify all features work in host mode

### For Future Sandbox Support

- [ ] Detect sandbox availability at runtime
- [ ] Add first-run prompt (optional)
- [ ] Settings panel to enable/disable
- [ ] Help documentation
- [ ] Support for `srt-win.exe install` from UI
- [ ] Graceful error messages
- [ ] Status indicator

---

## Answer to Your Question

> "In production, users won't install that manually, right?"

**Correct!** Here's the reality:

### Will Sandbox Work Out of the Box?
**No** - not without one of these:
1. Elevated installer that runs setup (Option 1)
2. User manually enables it (Option 2/3)
3. You don't use sandbox (Option 3 - recommended)

### Should You Worry?
**For Koala MVP: No**

Reasons:
- ✅ Document tools don't need sandbox
- ✅ Host execution is perfectly functional
- ✅ It's the user's own machine
- ✅ They control what code runs
- ✅ Simpler to deploy and support
- ✅ Most similar tools don't sandbox either

### When to Add Sandbox?
**Later, when:**
- Product is established
- Users trust it
- Enterprise customers request it
- Running untrusted/user-generated code
- Compliance requirements emerge

### Current Best Approach
**Ship with host mode, document sandbox as advanced feature**

This is common, accepted, and practical for desktop apps.

---

## Final Recommendation

**For your production .exe:**

1. **Use host execution mode by default**
2. **Ship without sandbox setup**
3. **Document tools work perfectly**
4. **Add sandbox as opt-in advanced feature**
5. **Provide clear setup guide for those who want it**

This matches how most developer tools ship and gives you:
- ✅ Clean installation experience
- ✅ No UAC prompts
- ✅ All features work immediately
- ✅ Simpler support
- ✅ Option to add sandbox later

The sandbox is important for security-conscious use cases, but not a launch blocker.
