@echo off
cd /d C:\Users\ADMIN\Desktop\cos0
echo SERVER_START %DATE% %TIME% > server.log
call npm run server >> server.log 2>&1
