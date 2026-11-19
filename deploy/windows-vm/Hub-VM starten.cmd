@echo off
rem Home Hub in VirtualBox starten (Anleitung: docs\VIRTUELLE-MASCHINE.md).
rem Das Fenster legt sich minimiert in die Taskleiste und haelt den PC wach, solange der Hub laeuft.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hub-vm.ps1" -Action start
if errorlevel 1 pause
