@echo off
rem Home Hub in VirtualBox sauber herunterfahren (Anleitung: docs\VIRTUELLE-MASCHINE.md).
rem Danach ist der Arbeitsspeicher der VM wieder frei.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hub-vm.ps1" -Action stop
if errorlevel 1 pause
