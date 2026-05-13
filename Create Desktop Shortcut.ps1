# Creates a desktop shortcut for ExpenseValidator.bat
$batPath    = Join-Path $PSScriptRoot "ExpenseValidator.bat"
$desktop    = [Environment]::GetFolderPath("Desktop")
$lnkPath    = Join-Path $desktop "Expense Validator.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath       = $batPath
$sc.WorkingDirectory = $PSScriptRoot
$sc.WindowStyle      = 1   # normal window
$sc.Description      = "Launch Expense Validator"

# Use a shell32 icon (briefcase / document icon — index 21)
$sc.IconLocation = "shell32.dll,21"

$sc.Save()
Write-Host "Shortcut created at: $lnkPath" -ForegroundColor Green
