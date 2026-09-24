; NSIS Custom Installer Script for Koala Desktop
; This script runs after the main installation to set up the sandbox environment
; Purpose: Configure Windows sandbox runtime for secure code execution
;
; The provisioning below (sandbox account, group, WFP filters, credential) is the
; only step that needs elevation. Koala itself runs non-elevated and, at every
; sandbox run, grants NTFS ACEs only on user-owned project and staging paths.

!verbose push
!verbose 3

; Custom installation section - runs after files are copied
!macro customInstall
  DetailPrint "Koala: Configuring secure sandbox environment..."
  
  ; Construct path to srt-win.exe in the installed resources
  ; Pattern: $INSTDIR\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe
  StrCpy $0 "$INSTDIR\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe"
  
  ; Check if srt-win.exe exists before attempting to run it
  IfFileExists $0 +1 sandbox_not_found
  
  DetailPrint "Koala: Found sandbox installer at: $0"
  DetailPrint "Koala: Creating sandbox user account and configuring Windows Filtering Platform..."
  
  ; Execute srt-win.exe install to:
  ; 1. Create the "srt-sandbox" Windows user account (member of BUILTIN\Users)
  ; 2. Store its DPAPI-protected credential under HKLM\SOFTWARE\sandbox-runtime
  ; 3. Configure machine-wide Windows Filtering Platform (WFP) filters
  ;
  ; The command is idempotent: re-running it on upgrade rotates the password and
  ; reconciles the filter set. It requires administrator privileges, which the
  ; installer already has due to perMachine: true in the electron-builder config.
  nsExec::ExecToLog '"$0" install'
  Pop $1
  
  ; Exit codes (srt-win.exe): 0 ok, 10 UAC cancelled, 12 WFP install failed,
  ; 13 already installed with different config, 14 user provisioning failed,
  ; 17 ambient write-deny stamping failed. "error" means it could not be launched.
  ${If} $1 == 0
    DetailPrint "Koala: Sandbox configured successfully"
    DetailPrint "Koala: Sandbox user srt-sandbox created"
    DetailPrint "Koala: Windows Filtering Platform configured"
  ${Else}
    ; Sandbox setup failed, but this shouldn't block installation.
    ; Koala runs in sandbox-only mode, so sandbox tools stay unavailable until
    ; the installer is re-run or "srt-win.exe install" is run from an elevated shell.
    DetailPrint "Koala: Warning: Sandbox setup failed (exit code: $1)"
    DetailPrint "Koala: Sandboxed code execution will be unavailable until setup succeeds"
    DetailPrint "Koala: Re-run the installer or run: $0 install (as administrator)"
  ${EndIf}
  
  Goto sandbox_complete
  
  sandbox_not_found:
    DetailPrint "Koala: Warning: Sandbox installer not found at expected location"
    DetailPrint "Koala: Expected: $0"
    DetailPrint "Koala: Sandboxed code execution will be unavailable"
    Goto sandbox_complete
  
  sandbox_complete:
    DetailPrint "Koala: Installation configuration complete"
    
!macroend

; Custom uninstallation section - runs during uninstall, before files are removed
!macro customUnInstall
  ; During an in-place upgrade electron-builder runs the previous uninstaller with
  ; --updated. Keep the sandbox account and WFP filters in that case; the new
  ; installer's customInstall reconciles them.
  ${IfNot} ${isUpdated}
    DetailPrint "Koala: Cleaning up sandbox environment..."
    
    ; Construct path to srt-win.exe
    StrCpy $0 "$INSTDIR\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe"
    
    ; Check if srt-win.exe exists
    IfFileExists $0 +1 sandbox_cleanup_skip
    
    DetailPrint "Koala: Removing sandbox configuration..."
    
    ; Run srt-win.exe uninstall to:
    ; 1. Remove "srt-sandbox" user account
    ; 2. Remove WFP filters
    ; 3. Clean up ACLs and permissions
    nsExec::ExecToLog '"$0" uninstall'
    Pop $1
    
    ${If} $1 == 0
      DetailPrint "Koala: Sandbox configuration removed"
    ${Else}
      DetailPrint "Koala: Warning: Sandbox cleanup incomplete (exit code: $1)"
      DetailPrint "Koala: You may need to manually remove srt-sandbox user account"
    ${EndIf}
    
    Goto sandbox_cleanup_complete
    
    sandbox_cleanup_skip:
      DetailPrint "Koala: Sandbox installer not found, skipping cleanup"
      Goto sandbox_cleanup_complete
    
    sandbox_cleanup_complete:
      DetailPrint "Koala: Uninstallation cleanup complete"
  ${EndIf}
  
!macroend

!verbose pop

; Notes for future maintenance:
;
; 1. The sandbox requires administrator privileges to set up correctly
; 2. Koala runs with KOALA_AGENT_EXECUTION=sandbox; there is no host-shell fallback.
;    If setup fails, sandbox tools report engine-unavailable until it is repaired.
; 3. Runtime ACL grants are made by the non-elevated app on user-owned paths only;
;    the installer never needs to grant ACLs on system directories.
; 4. The srt-sandbox user account should be cleaned up on real uninstall only
; 5. If uninstall cleanup fails, users can manually remove the account via:
;    Computer Management > Local Users and Groups > Users > srt-sandbox
; 6. Runtime prerequisite: the "Secondary Logon" (seclogon) Windows service must
;    not be disabled; CreateProcessWithLogonW depends on it. Hardened images
;    (e.g. DISA STIG) disable it, which makes every sandbox run fail.
;
; 7. Testing the installer:
;    - Test on clean Windows system without Koala
;    - Verify sandbox user is created: Get-LocalUser -Name "srt-sandbox"
;    - Verify runtime: "<install>\resources\sandbox-runtime\vendor\srt-win\x64\srt-win.exe" status
;    - Test upgrade keeps the account; test uninstaller removes it
;
; 8. Future enhancements:
;    - Show sandbox status in app settings
;    - Add troubleshooting UI for sandbox issues
