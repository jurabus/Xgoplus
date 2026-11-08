// Landing page for the membership QR when it's scanned with the phone's normal camera app.
// The token stays in the URL fragment (#…), so it is never sent to any server log.
const m = location.hash.match(/XG1\.[0-9a-f]{32}\.[0-9]{9,11}\.[0-9a-f]{32}/);
history.replaceState(null, '', location.pathname);
if (m) { try { sessionStorage.setItem('xg-verify', JSON.stringify({ t: m[0], at: Date.now() })); } catch { /* private mode */ } }
location.replace('partner.html?verify=1');
