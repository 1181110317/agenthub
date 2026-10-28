# One hidden, demand-driven worker. The parent terminates it after 12s without viewers.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$initialSample = $true
while ($true) {
  $adapters = @()
  foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback' -or $nic.NetworkInterfaceType -eq 'Tunnel') { continue }
    try {
      $stats = $nic.GetIPv4Statistics()
      $adapters += @{ id = $nic.Id; name = $nic.Name; rx = $stats.BytesReceived; tx = $stats.BytesSent }
    } catch {}
  }
  @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); scope = 'interfaces'; adapters = $adapters } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  if ($initialSample) { Start-Sleep -Milliseconds 300; $initialSample = $false }
  else { Start-Sleep -Milliseconds 2000 }
}
