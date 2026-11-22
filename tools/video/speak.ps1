Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('Microsoft Zira Desktop') } catch { Write-Host 'Zira not found, using default voice' }
$s.Rate = -1
$s.Volume = 100

$root = 'C:\Users\siddh\Desktop\Youtube_Extension\tools\video'
$outDir = Join-Path $root 'narr'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Get-ChildItem (Join-Path $root 'script\*.txt') | Sort-Object Name | ForEach-Object {
  $text = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
  $out = Join-Path $outDir ($_.BaseName + '.wav')
  $s.SetOutputToWaveFile($out)
  $s.Speak($text)
  Write-Host ($_.BaseName + ' ok')
}
$s.SetOutputToWaveFile($null)
$s.Dispose()
Write-Host 'all narration generated'
