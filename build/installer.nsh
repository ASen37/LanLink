; 卸载时一并清理配置与数据（含用户改过位置的数据目录）
!include "LogicLib.nsh"

!macro customUnInstall
  ${If} ${FileExists} "$APPDATA\LanLink\data-path.txt"
    FileOpen $0 "$APPDATA\LanLink\data-path.txt" r
    FileRead $0 $1
    FileClose $0
    ${If} $1 != ""
      ; 去掉可能的回车/换行，避免路径带空白
      StrCpy $2 $1 1 -1
      ${If} $2 == "$\r"
        StrCpy $1 $1 -1
      ${EndIf}
      StrCpy $2 $1 1 -1
      ${If} $2 == "$\n"
        StrCpy $1 $1 -1
      ${EndIf}
      RMDir /r "$1"
    ${EndIf}
  ${EndIf}

  RMDir /r "$APPDATA\LanLink"
  RMDir /r "$LOCALAPPDATA\LanLink"
!macroend
