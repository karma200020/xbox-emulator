$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root "apps\extension\icons"
$assets = Join-Path $root "store-assets"
New-Item -ItemType Directory -Force -Path $icons, $assets | Out-Null

function New-Icon([int]$size, [string]$path) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $scale = $size / 128.0
    $body = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 20, 28, 42))
    $accent = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 57, 220, 170), (7 * $scale))
    $accent.StartCap = $accent.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $rect = New-Object System.Drawing.RectangleF((16 * $scale), (30 * $scale), (96 * $scale), (68 * $scale))
    $graphics.FillRoundedRectangle($body, $rect, (24 * $scale))
    $graphics.DrawLine($accent, (38 * $scale), (64 * $scale), (58 * $scale), (64 * $scale))
    $graphics.DrawLine($accent, (48 * $scale), (54 * $scale), (48 * $scale), (74 * $scale))
    $graphics.FillEllipse([System.Drawing.Brushes]::White, (78 * $scale), (53 * $scale), (10 * $scale), (10 * $scale))
    $graphics.FillEllipse([System.Drawing.Brushes]::White, (91 * $scale), (66 * $scale), (10 * $scale), (10 * $scale))
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $accent.Dispose()
    $body.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

Update-TypeData -TypeName System.Drawing.Graphics -MemberType ScriptMethod `
    -MemberName FillRoundedRectangle -Value {
        param($brush, $rect, $radius)
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $diameter = $radius * 2
        $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
        $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
        $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
        $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
        $this.FillPath($brush, $path)
        $path.Dispose()
    } -Force

foreach ($size in 16, 32, 48, 128) {
    New-Icon $size (Join-Path $icons "icon$size.png")
}

$promo = New-Object System.Drawing.Bitmap(440, 280)
$g = [System.Drawing.Graphics]::FromImage($promo)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, 440, 280)),
    [System.Drawing.Color]::FromArgb(255, 10, 16, 28),
    [System.Drawing.Color]::FromArgb(255, 20, 84, 94),
    25
)
$g.FillRectangle($background, 0, 0, 440, 280)
$controller = [System.Drawing.Image]::FromFile((Join-Path $icons "icon128.png"))
$g.DrawImage($controller, 156, 58, 128, 128)
$keyBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 57, 220, 170))
foreach ($x in 174, 212, 250) { $g.FillRoundedRectangle($keyBrush, (New-Object System.Drawing.RectangleF($x, 202, 30, 30)), 6) }
$g.FillRoundedRectangle($keyBrush, (New-Object System.Drawing.RectangleF(212, 164, 30, 30)), 6)
$promo.Save((Join-Path $assets "small-promo-440x280.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$keyBrush.Dispose()
$controller.Dispose()
$background.Dispose()
$g.Dispose()
$promo.Dispose()
