!macro customInit
  ; This dedicated installer alone clears the current desktop user's approved TEK STOCK data.
  InitPluginsDir
  File /oname=$PLUGINSDIR\clean-reinstall.ps1 "${BUILD_RESOURCES_DIR}\clean-reinstall.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\clean-reinstall.ps1" -RunProduction'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "TEK STOCK clean reinstall stopped: $1"
    Abort
  ${EndIf}
!macroend
