; NSIS Custom Installer Script for Koala Desktop
; This script runs after the main installation to set up the sandbox environment
; Author: Auto-generated for Koala Desktop elevated installer
; Purpose: Configure Windows sandbox runtime for secure code execution

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
  ; 1. Create "srt-sandbox" Windows user account
  ; 2. Configure Windows Filtering Platform (WFP) filters
  ; 3. Set up necessary ACLs and permissions
  ;
  ; Note: This command requires administrator privileges, which the installer
  ; already has due to perMachine: true setting in electron-builder config
  nsExec::ExecToLog '"$0" install'
  Pop $1
  
  ; Check exit code
  ; 0 = success
  ; Non-zero = error occurred
  ${If} $1 == 0
    DetailPrint "Koala: ✓ Sandbox configured successfully"
    DetailPrint "Koala: Sandbox user 'srt-sandbox' created"
    DetailPrint "Koala: Windows Filtering Platform configured"
  ${Else}
    ; Sandbox setup failed, but this shouldn't block installation
    ; The app can still run in host mode if sandbox isn't available
    DetailPrint "Koala: ⚠ Warning: Sandbox setup failed (exit code: $1)"
    DetailPrint "Koala: Application will use host execution mode"
    DetailPrint "Koala: Some security isolation features may be limited"
    ; Note: We don't abort installation - the app is still functional
  ${EndIf}
  
  Goto sandbox_complete
  
  sandbox_not_found:
    DetailPrint "Koala: ⚠ Warning: Sandbox installer not found at expected location"
    DetailPrint "Koala: Expected: $0"
    DetailPrint "Koala: Application will use host execution mode"
    Goto sandbox_complete
  
  sandbox_complete:
    DetailPrint "Koala: Installation configuration complete"
    
!macroend

; Custom uninstallation section - runs during uninstall
!macro customUnInstall
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
    DetailPrint "Koala: ✓ Sandbox configuration removed"
  ${Else}
    DetailPrint "Koala: ⚠ Warning: Sandbox cleanup incomplete (exit code: $1)"
    DetailPrint "Koala: You may need to manually remove 'srt-sandbox' user account"
  ${EndIf}
  
  Goto sandbox_cleanup_complete
  
  sandbox_cleanup_skip:
    DetailPrint "Koala: Sandbox installer not found, skipping cleanup"
    Goto sandbox_cleanup_complete
  
  sandbox_cleanup_complete:
    DetailPrint "Koala: Uninstallation cleanup complete"
    
!macroend

; Notes for future maintenance:
;
; 1. The sandbox requires administrator privileges to set up correctly
; 2. If sandbox setup fails, the app will fallback to host execution mode
; 3. Host mode is fully functional but lacks process isolation
; 4. The srt-sandbox user account should be cleaned up on uninstall
; 5. If uninstall cleanup fails, users can manually remove the account via:
;    Computer Management > Local Users and Groups > Users > srt-sandbox
;
; 6. Error codes from srt-win.exe:
;    0 = Success
;    1 = General error (permissions, user already exists, etc.)
;    5 = Access denied (should not occur with elevated installer)
;
; 7. Testing the installer:
;    - Test on clean Windows system without Koala
;    - Verify sandbox user is created: Get-LocalUser -Name "srt-sandbox"
;    - Test uninstaller removes sandbox user
;    - Test app runs if sandbox setup fails
;
; 8. Future enhancements:
;    - Add option to skip sandbox setup
;    - Show sandbox status in app settings
;    - Allow users to enable/disable sandbox post-install
;    - Add troubleshooting UI for sandbox issues
