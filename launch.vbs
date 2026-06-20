' 디스패처 봇을 창 없이(숨김) 백그라운드로 실행. 자기 폴더의 run.bat 호출.
Dim fso, sh, folder
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
sh.Run """" & folder & "\run.bat""", 0, False
