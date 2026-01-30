const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// --------------------
// Render-friendly storage location
// If /var/data exists (Render disk mount), use it.
// Otherwise use the current folder (your PC local dev).
// --------------------
const DATA_DIR = fs.existsSync("/var/data") ? "/var/data" : __dirname;

const DATA_FILE = path.join(DATA_DIR, "fridge.json");
const CACHE_FILE = path.join(DATA_DIR, "barcode-cache.json");

// --------------------
// Load saved items
// --------------------
let fridgeItems = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    fridgeItems = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    fridgeItems = [];
  }
}

// --------------------
// Load barcode cache
// --------------------
let barcodeCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    barcodeCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    barcodeCache = {};
  }
}

let message = "";

function saveFridge() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(fridgeItems, null, 2));
}
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(barcodeCache, null, 2));
}

// --------------------
// Helpers
// --------------------
const CATEGORIES = ["Dairy", "Meat", "Vegetables", "Fruit", "Other"];
function safeCategory(c) {
  return CATEGORIES.includes(c) ? c : "Other";
}

function toDateOrNull(yyyy_mm_dd) {
  if (!yyyy_mm_dd) return null;
  const d = new Date(yyyy_mm_dd);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// --------------------
// Barcode lookup with cache
// --------------------
function lookupBarcode(barcode, callback) {
  if (!barcode) return callback(null);

  // Cache hit (including cached null)
  if (Object.prototype.hasOwnProperty.call(barcodeCache, barcode)) {
    callback(barcodeCache[barcode]);
    return;
  }

  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
  https
    .get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const name =
            j &&
            j.status === 1 &&
            j.product &&
            j.product.product_name
              ? j.product.product_name
              : null;

          // Cache result (even null)
          barcodeCache[barcode] = name;
          saveCache();

          callback(name);
        } catch {
          callback(null);
        }
      });
    })
    .on("error", () => callback(null));
}

// --------------------
// Simple form decoder
// --------------------
function parseForm(body) {
  const out = {};
  (body || "")
    .split("&")
    .map((p) => p.split("="))
    .forEach(([k, v]) => {
      if (!k) return;
      out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
  return out;
}

// --------------------
// Server
// --------------------
const server = http.createServer((req, res) => {
  // ---------- API: barcode lookup (for auto-fill on scan) ----------
  if (req.method === "GET" && req.url.startsWith("/lookup")) {
    const url = new URL(req.url, "http://localhost");
    const barcode = url.searchParams.get("barcode") || "";
    lookupBarcode(barcode, (name) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: name || "" }));
    });
    return;
  }

  // ---------- POST ----------
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = parseForm(body);

      // ADD (name="add")
      if (Object.prototype.hasOwnProperty.call(form, "add")) {
        const name = (form.add || "").trim();
        const barcode = (form.barcode || "").trim();
        const expiry = (form.expiry || "").trim();
        const category = safeCategory((form.category || "Other").trim());

        // Block duplicate barcode (if barcode provided)
        if (barcode) {
          const exists = fridgeItems.some((it) => it && it.barcode === barcode);
          if (exists) {
            message = "Item already in fridge";
            res.writeHead(302, { Location: "/" });
            res.end();
            return;
          }
        }

        // If name is blank but barcode exists, do lookup and save
        if (!name && barcode) {
          lookupBarcode(barcode, (found) => {
            fridgeItems.push({
              name: found || "(unnamed item)",
              barcode,
              expiry,
              category,
            });
            saveFridge();

            if (!found) message = "Product not found — please rename";
            res.writeHead(302, { Location: "/" });
            res.end();
          });
          return;
        }

        // Manual add
        if (name || barcode) {
          fridgeItems.push({
            name: name || "(unnamed item)",
            barcode,
            expiry,
            category,
          });
          saveFridge();
        }
      }

      // RENAME (rename=INDEX&name=NEWNAME)
      if (Object.prototype.hasOwnProperty.call(form, "rename")) {
        const idx = parseInt(form.rename, 10);
        const newName = (form.name || "").trim();
        if (!Number.isNaN(idx) && fridgeItems[idx] && newName) {
          fridgeItems[idx].name = newName;
          saveFridge();
        }
      }

      // SET CATEGORY (setcat=INDEX&category=CAT)
      if (Object.prototype.hasOwnProperty.call(form, "setcat")) {
        const idx = parseInt(form.setcat, 10);
        const cat = safeCategory((form.category || "Other").trim());
        if (!Number.isNaN(idx) && fridgeItems[idx]) {
          fridgeItems[idx].category = cat;
          saveFridge();
        }
      }

      // REMOVE (remove=INDEX)
      if (Object.prototype.hasOwnProperty.call(form, "remove")) {
        const idx = parseInt(form.remove, 10);
        if (!Number.isNaN(idx)) {
          fridgeItems.splice(idx, 1);
          saveFridge();
        }
      }

      // CLEAR (clear=true)
      if (form.clear === "true") {
        fridgeItems = [];
        saveFridge();
      }

      res.writeHead(302, { Location: "/" });
      res.end();
    });
    return;
  }

  // ---------- PAGE (GET) ----------
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Expiring soon (<= 3 days, including expired)
  const expiringSoon = fridgeItems
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => {
      const d = toDateOrNull(item && item.expiry);
      if (!d) return false;
      const diffDays = Math.floor((d - today) / 86400000);
      return diffDays <= 3;
    })
    .sort((a, b) => {
      const da = toDateOrNull(a.item.expiry);
      const db = toDateOrNull(b.item.expiry);
      return da - db;
    });

  let html = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Fridge</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:0;padding:14px;max-width:760px;margin-inline:auto;}
  h1{margin:6px 0 10px 0;font-size:1.6rem;}
  h2{margin:18px 0 8px 0;font-size:1.15rem;}
  .row{display:flex;gap:8px;flex-wrap:wrap;}
  input,select,button{font-size:1rem;padding:10px;border:1px solid #ccc;border-radius:10px;}
  input,select{flex:1;min-width:140px;}
  button{background:#111;color:#fff;border:none;border-radius:10px;padding:10px 14px;cursor:pointer;}
  button.secondary{background:#444;}
  .msg{color:#b00020;margin:8px 0;}
  ul{padding-left:18px;}
  li{margin:10px 0;line-height:1.35;}
  .pill{display:inline-block;padding:2px 8px;border:1px solid #ddd;border-radius:999px;font-size:.9rem;margin-left:6px;}
  .danger{color:#b00020;}
  .warn{color:#d07a00;}
  .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px;}
  .inlineForm{display:inline;}
  #scanner{display:none; width: 100%; max-width: 420px; height: 280px; border:1px solid #ccc; border-radius:12px; overflow:hidden; margin-top:10px;}
  .small{font-size:.95rem;color:#333;}
</style>
</head>
<body>
<h1>My Fridge</h1>
`;

  if (message) {
    html += `<div class="msg">${message}</div>`;
    message = "";
  }

  // Search
  html += `
<div class="row">
  <input id="search" placeholder="Search..." onkeyup="filterItems()" />
</div>
<br/>
`;

  // Add form (includes expiry + category)
  html += `
<form method="POST">
  <div class="row">
    <input id="name" name="add" placeholder="Add item" />
    <input id="barcode" name="barcode" placeholder="Barcode" />
    <input type="date" name="expiry" />
    <select name="category">
      ${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}
    </select>
    <button type="submit">Add</button>
  </div>
</form>

<div class="controls">
  <button class="secondary" onclick="startScan()" type="button">Scan Barcode</button>
  <form method="POST" class="inlineForm">
    <button class="secondary" name="clear" value="true" type="submit">Clear Fridge</button>
  </form>
</div>

<div id="scanner"></div>
`;

  // Expiring soon section
  if (expiringSoon.length > 0) {
    html += `<h2>Expiring Soon</h2><ul>`;
    expiringSoon.forEach(({ item }) => {
      html += `<li class="danger">${item.name || "(unnamed item)"} <span class="pill">${safeCategory(item.category)}</span> — expires ${item.expiry}</li>`;
    });
    html += `</ul><hr/>`;
  }

  // List items (sorted by expiry, no-expiry last)
  const sorted = fridgeItems
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ea = toDateOrNull(a.item && a.item.expiry);
      const eb = toDateOrNull(b.item && b.item.expiry);
      if (!ea && !eb) return 0;
      if (!ea) return 1;
      if (!eb) return -1;
      return ea - eb;
    });

  html += `<h2>All Items</h2><ul>`;

  sorted.forEach(({ item, i }) => {
    const name = item && item.name ? item.name : "(unnamed item)";
    const barcode = item && item.barcode ? item.barcode : "";
    const expiry = item && item.expiry ? item.expiry : "";
    const category = safeCategory(item && item.category);

    let cls = "";
    const d = toDateOrNull(expiry);
    if (d) {
      const diffDays = Math.floor((d - today) / 86400000);
      if (diffDays < 0) cls = "danger";
      else if (diffDays <= 3) cls = "warn";
    }

    html += `<li class="${cls}">
      <strong>${name}</strong>
      <span class="pill">${category}</span>
      ${barcode ? `<span class="small"> (barcode: ${barcode})</span>` : ""}
      ${expiry ? `<span class="small"> — expires ${expiry}</span>` : ""}
      <div class="controls">
        <button class="secondary" type="button" onclick="renameItem(${i})">Rename</button>

        <select onchange="setCategory(${i}, this.value)">
          ${CATEGORIES.map((c) => `<option ${c === category ? "selected" : ""}>${c}</option>`).join("")}
        </select>

        <form method="POST" class="inlineForm">
          <button name="remove" value="${i}" type="submit">Remove</button>
        </form>
      </div>
    </li>`;
  });

  html += `</ul>

<script src="https://unpkg.com/quagga@0.12.1/dist/quagga.min.js"></script>
<script>
function filterItems(){
  const q = document.getElementById("search").value.toLowerCase();
  document.querySelectorAll("li").forEach(li=>{
    li.style.display = li.innerText.toLowerCase().includes(q) ? "" : "none";
  });
}

function renameItem(index){
  const n = prompt("Enter new name:");
  if(!n) return;
  const f = document.createElement("form");
  f.method = "POST";
  f.innerHTML = '<input name="rename" value="'+index+'"><input name="name" value="'+n.replace(/"/g,'&quot;')+'">';
  document.body.appendChild(f);
  f.submit();
}

function setCategory(index, cat){
  const f = document.createElement("form");
  f.method = "POST";
  f.innerHTML = '<input name="setcat" value="'+index+'"><input name="category" value="'+cat+'">';
  document.body.appendChild(f);
  f.submit();
}

function startScan(){
  const box = document.getElementById("scanner");
  box.style.display = "block";
  box.innerHTML = "";

  Quagga.init({
    inputStream:{
      type:"LiveStream",
      target: box,
      constraints:{ facingMode:"environment" }
    },
    decoder:{ readers:["ean_reader","ean_8_reader","upc_reader"] }
  }, function(err){
    if(err){ alert(err); return; }
    Quagga.start();
  });

  Quagga.offDetected();
  Quagga.onDetected(function(data){
    const code = data.codeResult.code;
    document.getElementById("barcode").value = code;

    // auto-fill name immediately via /lookup
    fetch("/lookup?barcode=" + encodeURIComponent(code))
      .then(r => r.json())
      .then(j => {
        if(j && j.name){
          document.getElementById("name").value = j.name;
        }
      });

    Quagga.stop();
    box.style.display = "none";
  });
}
</script>

</body></html>`;

  res.end(html);
});

// ✅ Render uses its own PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT);

console.log("Fridge app running on port", PORT);
