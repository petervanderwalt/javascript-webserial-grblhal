# Download Roboto (variable) and Nunito (variable) WOFF2 fonts - Latin subset only
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$fonts = @(
    @{ url = "https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2";  file = "Roboto.woff2" },
    @{ url = "https://fonts.gstatic.com/s/nunito/v32/XRXV3I6Li01BKofINeaB.woff2";                     file = "Nunito.woff2" }
)

foreach ($f in $fonts) {
    $dest = Join-Path $dir $f.file
    Write-Host "Downloading $($f.file)..."
    try {
        Invoke-WebRequest -Uri $f.url -OutFile $dest -UseBasicParsing
        $size = (Get-Item $dest).Length
        Write-Host "  OK: $($f.file) ($size bytes)"
    } catch {
        Write-Host "  FAILED: $_"
    }
}
Write-Host "All done."
