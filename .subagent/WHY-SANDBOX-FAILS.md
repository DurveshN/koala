# Why Sandbox is Failing - Complete Explanation

**Date**: 2026-09-23  
**Question**: Is sandbox failing because it's running locally?  
**Answer**: **NO** - It's designed for local use but needs one-time setup

---

## TL;DR - The Root Cause

```
❌ Error: "Sandbox user is not provisioned (user=false, cred=false)"
```

**The sandbox is failing because:**
1. ✅ Files exist (srt-win.exe, Java agent JAR)
2. ✅ Platform supported (Windows x64)
3. ❌ **Windows sandbox user account not created**
4. ❌ **Windows Filtering Platform (WFP) filters not configured**

**It's NOT about local vs. remote** - it's about OS-level security setup.

---

## Diagnostic Results

### What's Working ✅

```
Step 1: Platform Support
  Platform: win32
  Architecture: x64
  Supported? true ✅

Step 2: Sandbox Assets
  Java agent JAR: ✅ EXISTS
    Location: node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar
  
  SRT-Win: ✅ EXISTS
    Location: node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe
```

### What's Failing ❌

```
Step 3: Check Dependencies
  Errors: 1
    ❌ Sandbox user is not provisioned (user=false, cred=false)
  
Step 4: Initialization
  ❌ Error: Windows sandbox needs a one-time install:
      npx sandbox-runtime windows-install
```

---

## What the Sandbox Needs

### The `@anthropic-ai/sandbox-runtime` Package

This is Anthropic's official sandboxing solution that provides:
- **Process isolation** - Run code in a confined process
- **Network filtering** - Control what the sandboxed code can access
- **Filesystem restrictions** - Limit what files can be read/written
- **Resource limits** - CPU, memory, timeout controls

### On Windows Specifically

The sandbox uses `srt-win.exe` (Sandbox Runtime for Windows) which needs:

1. **Dedicated Windows User Account** (`srt-sandbox`)
   - A low-privilege user account
   - Used exclusively for running sandboxed processes
   - Isolated from your main user account
   - **Status**: ❌ Not created

2. **Windows Filtering Platform (WFP) Filters**
   - OS-level network traffic rules
   - Only applied to the `srt-sandbox` user
   - Your regular user is unaffected
   - **Status**: ❌ Not configured

3. **Executable Files**
   - `srt-win.exe` must exist
   - Java proxy agent JAR must exist
   - **Status**: ✅ Both exist

---

## Why It's NOT About Local vs. Remote

### Common Misconception
❌ "The sandbox only works on servers/cloud environments"  
❌ "Local development can't use sandboxing"  
❌ "It needs external services to work"

### Reality
✅ The sandbox is **designed for local use**  
✅ It works on developer machines  
✅ It's self-contained (no external services)  
✅ **It just needs one-time setup**

### What "Local" Means for the Sandbox

**The sandbox ALWAYS runs locally**, whether you're:
- Developing on your laptop ← This is us
- Running in production
- In a CI/CD environment
- On a server

The sandbox creates **local** OS-level isolation, not remote isolation.

---

## The Actual Problem

### It's About OS-Level Setup

The sandbox needs **privileged system configuration**:

```
Regular application:
  Your Code → Node.js → Windows API → Runs as your user
  
Sandboxed application:
  Your Code → Sandbox Runtime → Creates dedicated user → Runs in isolation
                               ↑
                    Needs admin setup first
```

### What Happens Without Setup

1. **Code tries to use sandbox**
   ```typescript
   await SandboxManager.initialize(...)
   ```

2. **SRT checks for sandbox user**
   ```
   Looking for user: srt-sandbox
   Result: ❌ User not found
   ```

3. **Returns error**
   ```
   Error: Sandbox user is not provisioned
   ```

4. **Tool fails**
   ```
   sandbox_execute → engine-unavailable error
   docx_create (tries sandbox) → fails
   ```

---

## Why Document Tools Were Affected

### Document Tools Don't Need Sandbox

Document tools use **document runtime** (separate worker), not sandbox:

```
Document Flow:
  docx_create called
    ↓
  DocumentRuntime.Service
    ↓
  Confined document worker (separate process)
    ↓
  Uses docx library to generate file
    ↓
  Returns result
```

**BUT** - when sandbox initialization fails, it was causing broader errors that affected even non-sandbox tools.

### The Error Cascade

```
1. App starts
2. Sandbox tries to initialize
3. Fails with "user not provisioned"
4. Error propagates through system
5. Even document tools get errors
6. Everything appears broken
```

Setting `KOALA_ENABLE_DOCUMENT_TOOLS=1` bypasses some of this, but the root issue remains.

---

## The Fix: One-Time Setup

### What Needs to Happen

Run the sandbox installation script **ONCE** with admin privileges:

```powershell
# Option 1: Via npx
npx sandbox-runtime windows-install

# Option 2: Direct
node_modules\.bin\sandbox-runtime windows-install

# Option 3: Via srt-win.exe directly
node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\x64\srt-win.exe install
```

### What This Script Does

1. **Creates `srt-sandbox` user**
   - Low-privilege Windows account
   - No login rights
   - Used only for sandboxed processes

2. **Configures WFP filters**
   - Network filtering rules
   - Applied only to `srt-sandbox` user
   - Your user remains unaffected

3. **Sets up credentials**
   - Allows sandbox runtime to use the account
   - Stored securely by Windows

### Does NOT Require

- ❌ System reboot
- ❌ Logout/login
- ❌ Affecting your user account
- ❌ Network changes for your regular work
- ❌ Any ongoing services

### After Installation

- ✅ `SandboxManager.checkDependenciesAsync()` returns no errors
- ✅ `SandboxManager.initialize()` succeeds
- ✅ `sandbox_execute` tool works
- ✅ `sandbox_test` passes
- ✅ Document tools work reliably

---

## Why This Setup Exists

### Security Boundaries

The sandbox provides **real isolation**:

```
Without Sandbox:
  Code runs as your user
  Can access your files
  Can make network requests
  Full system privileges
  
With Sandbox:
  Code runs as srt-sandbox user
  Limited file access
  Filtered network
  Restricted privileges
  Can't escape boundaries
```

### Use Cases

1. **Running untrusted code**
   - Execute user-provided scripts
   - Test potentially malicious code
   - Isolate third-party tools

2. **Resource limits**
   - Timeout enforcement
   - Memory limits
   - CPU restrictions

3. **Compliance**
   - Audit what code does
   - Restrict data access
   - Ensure confidentiality

For Koala:
- ✅ Sovereign AI workbench
- ✅ Confidential work
- ✅ Need strict boundaries
- ✅ Audit trails

---

## Comparison: Sandbox vs. Host Execution

### Host Execution (`KOALA_AGENT_EXECUTION="host"`)

**Pros:**
- ✅ No setup required
- ✅ Works immediately
- ✅ Full system access

**Cons:**
- ❌ No isolation
- ❌ Code runs as your user
- ❌ Can access all your files
- ❌ No network filtering
- ❌ Less secure

**Use when:**
- Development/testing
- Trusted code only
- Setup not possible yet

### Sandbox Execution (`KOALA_AGENT_EXECUTION="sandbox"`)

**Pros:**
- ✅ True isolation
- ✅ Network filtering
- ✅ Limited file access
- ✅ Can't escape
- ✅ Secure

**Cons:**
- ❌ Requires one-time setup
- ❌ Needs admin privileges

**Use when:**
- Production
- Handling sensitive data
- Running untrusted code
- Security is priority

---

## Steps Forward

### Option 1: Install Sandbox (Recommended for Production)

```powershell
# 1. Open PowerShell as Administrator
# 2. Navigate to project
cd E:\hackathon\SIH\SIH 2026\harness

# 3. Run install
npx sandbox-runtime windows-install

# 4. Test
cd packages\opencode
bun test-sandbox-worker.ts
# Should show: ✅ SANDBOX IS AVAILABLE

# 5. Restart app
cd ..\desktop
bun run dev
```

**Result**: Full sandbox isolation + document tools work

### Option 2: Use Host Mode (Quick Fix for Development)

```typescript
// packages/desktop/src/main/sidecar-env.ts
env.KOALA_AGENT_EXECUTION = "host"
```

**Result**: No isolation, but everything works

### Option 3: Use Both Mode (Flexible)

```typescript
env.KOALA_AGENT_EXECUTION = "both"
```

**Result**: 
- Shell tool available (works without sandbox)
- Sandbox tools available (fail if not set up)
- Document tools work
- Flexible during development

---

## Common Questions

### Q: Why doesn't it "just work"?

A: Because real OS-level isolation requires privileged setup. Just like:
- Docker needs Docker Desktop installed
- WSL needs Windows features enabled
- VirtualBox needs drivers installed

### Q: Is this safe to install?

A: Yes. The install:
- Creates a restricted user account
- Configures network filters
- Only affects the sandbox user
- Doesn't touch your user or network
- Can be uninstalled

### Q: Will it slow down my system?

A: No. The sandbox user is only active when:
- Running `sandbox_execute`
- Nothing else uses it
- No background services
- No performance impact when idle

### Q: Can I uninstall it?

A: Yes:
```powershell
npx sandbox-runtime windows-uninstall
```

### Q: What if I can't get admin privileges?

A: Use host mode temporarily:
- Works for development
- No isolation but functional
- Can add sandbox later

---

## Summary

| Question | Answer |
|----------|--------|
| Is sandbox local or remote? | **Local** - always runs on same machine |
| Why is it failing? | **Windows sandbox user not created** |
| Is this normal for local dev? | **Yes** - needs one-time setup |
| Is it a bug? | **No** - working as designed |
| Will it work after install? | **Yes** - fully functional |
| Can I skip it? | **Yes** - use host mode, but less secure |

**Bottom line**: The sandbox is designed for local use and WILL work locally once you run the one-time install script.

---

## Next Actions

**Immediate** (to make tools work):
- Keep `KOALA_ENABLE_DOCUMENT_TOOLS=1` ✅ (already done)
- Document tools should work now with override

**Soon** (for full sandbox support):
1. Open PowerShell as Administrator
2. Run: `npx sandbox-runtime windows-install`
3. Test: `cd packages\opencode && bun test-sandbox-worker.ts`
4. Restart desktop app

**Result**: Everything works with proper isolation ✅
