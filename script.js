/* =========================================================
   PROFINDER - CLOUD SYNC v2 (Firebase Realtime Database + Auth, REST)
   Ilagay sa index.html, sa ganitong ayos:
       <script src="cloud-sync.js"></script>
       <script src="script.js"></script>
       <script src="firebase-auth.js"></script>
   Hindi binabago ang script.js. Ang localStorage ay nagiging "mirror"
   ng online database, kaya pareho ang data ng lahat ng gumagamit.
========================================================= */

const CLOUD_SYNC = {
    // Firebase Console > Build > Realtime Database > (kopyahin ang URL)
    databaseUrl: "YOUR_FIREBASE_DATABASE_URL",
    // Firebase Console > Project settings > General > Web API Key
    apiKey: "YOUR_FIREBASE_API_KEY",
    root: "profinder",
    pollMs: 10000,
    // Bukas basahin ng lahat (specialists at reviews)
    publicKeys: [
        "profinderSpecialists",
        "profinderJoinedSpecialists",
        "profinderGeneralReviews",
        "profinderSpecialistReviews"
    ]
};

(function () {
    const cfg = CLOUD_SYNC;
    const placeholder = v => !v || String(v).startsWith("YOUR_");
    if (placeholder(cfg.databaseUrl) || placeholder(cfg.apiKey)) {
        console.info("[cloud-sync] Hindi pa naka-set ang databaseUrl / apiKey. Local-only muna.");
        return;
    }

    const USERS = "profinderUsers";          // sa cloud: "profiles" (walang password)
    const BOOKINGS = "profinderBookings";    // basahin lang kapag naka-login
    const base = cfg.databaseUrl.replace(/\/+$/, "") + "/" + cfg.root;
    const syncedKeys = [...cfg.publicKeys, BOOKINGS, USERS];
    const rawSet = Storage.prototype.setItem;
    const rawGet = Storage.prototype.getItem;
    let pendingPushes = 0;

    const remoteName = key => (key === USERS ? "profiles" : key);
    const isPrivate = key => key === BOOKINGS;
    const lower = v => String(v || "").trim().toLowerCase();
    const urlFor = (key, token) =>
        `${base}/${remoteName(key)}.json` + (token ? `?auth=${encodeURIComponent(token)}` : "");

    // Bawal ang . $ # [ ] / sa Firebase keys (halimbawa ang email)
    const encodeKey = k => String(k).replace(/[.$#\[\]\/]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

    function readJSON(key, fallback) {
        try {
            const value = JSON.parse(rawGet.call(localStorage, key));
            return value == null ? fallback : value;
        } catch {
            return fallback;
        }
    }

    /* ================= AUTH (Firebase Authentication, REST) ================= */
    const AUTH_STORE = "profinderCloudAuth";

    const CloudAuth = {
        configured: true,

        _read() {
            try { return JSON.parse(sessionStorage.getItem(AUTH_STORE)); } catch { return null; }
        },
        set(data) {
            sessionStorage.setItem(AUTH_STORE, JSON.stringify({
                idToken: data.idToken,
                refreshToken: data.refreshToken,
                expires: Date.now() + (Number(data.expiresIn) || 3600) * 1000
            }));
        },
        clear() {
            sessionStorage.removeItem(AUTH_STORE);
        },
        isSignedIn() {
            return !!this._read();
        },
        tokenSync() {
            const t = this._read();
            return t && Date.now() < t.expires - 30000 ? t.idToken : null;
        },
        async token() {
            const t = this._read();
            if (!t) return null;
            if (Date.now() < t.expires - 60000) return t.idToken;
            try {
                const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refreshToken)}`
                });
                const data = await res.json();
                if (!res.ok) { this.clear(); return null; }
                this.set({ idToken: data.id_token, refreshToken: data.refresh_token, expiresIn: data.expires_in });
                return data.id_token;
            } catch {
                return null;
            }
        },

        async _call(endpoint, body) {
            try {
                const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${cfg.apiKey}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (!res.ok) return { ok: false, error: (data.error && data.error.message) || "UNKNOWN" };
                return { ok: true, data };
            } catch {
                return { ok: false, error: "NETWORK" };
            }
        },
        signUp(email, password) {
            return this._call("accounts:signUp", { email, password, returnSecureToken: true });
        },
        signIn(email, password) {
            return this._call("accounts:signInWithPassword", { email, password, returnSecureToken: true });
        },
        sendReset(email) {
            return this._call("accounts:sendOobCode", { requestType: "PASSWORD_RESET", email });
        },

        explain(code) {
            const c = String(code || "");
            if (c.startsWith("EMAIL_EXISTS")) return "This email already has a password.";
            if (c.startsWith("WEAK_PASSWORD")) return "Password must be at least 6 characters.";
            if (c.startsWith("TOO_MANY_ATTEMPTS")) return "Too many attempts. Please wait a few minutes and try again.";
            if (c === "NETWORK") return "No internet connection. Please try again.";
            if (c.startsWith("EMAIL_NOT_FOUND") || c.startsWith("INVALID_PASSWORD") || c.startsWith("INVALID_LOGIN_CREDENTIALS")) {
                return "Incorrect password. Try again, or tap “Forgot password?”.";
            }
            if (c.startsWith("OPERATION_NOT_ALLOWED")) return "Email/Password sign-in is not enabled in Firebase Authentication.";
            if (c.startsWith("API_KEY") || c.startsWith("INVALID_API_KEY")) return "Invalid Firebase API key.";
            return "Something went wrong (" + c + ").";
        },
        isBadCredentials(code) {
            const c = String(code || "");
            return c.startsWith("INVALID_LOGIN_CREDENTIALS") || c.startsWith("EMAIL_NOT_FOUND") || c.startsWith("INVALID_PASSWORD");
        }
    };

    /* ================= DATA SHAPES (local <-> cloud) ================= */
    // Bawat entry ay sariling string sa database, para hindi mao-overwrite ng isa ang entry ng iba.
    function buildEntries(key, text) {
        let parsed;
        try { parsed = JSON.parse(text); } catch { return null; }
        const out = {};

        if (key === BOOKINGS) {
            (Array.isArray(parsed) ? parsed : []).forEach(b => {
                if (b && b.id != null) out[encodeKey(b.id)] = JSON.stringify(b);
            });
        } else if (key === USERS) {
            // Profile lang ang ina-upload: kapag may Firebase password na. Walang password at walang malaking draft.
            (Array.isArray(parsed) ? parsed : []).forEach(u => {
                if (!u || !u.email || !u.passwordSet) return;
                const { password, pendingSpecialist, ...safe } = u;
                out[encodeKey(lower(u.email))] = JSON.stringify(safe);
            });
        } else {
            Object.keys(parsed || {}).forEach(k => {
                out[encodeKey(k)] = JSON.stringify(parsed[k]);
            });
        }
        return out;
    }

    function decodeEntries(remote) {
        const out = {};
        Object.keys(remote || {}).forEach(k => {
            try { out[decodeURIComponent(k)] = JSON.parse(remote[k]); } catch { /* skip sirang entry */ }
        });
        return out;
    }

    // Returns true kung may nagbago sa local data
    function applyRemote(key, remote) {
        const before = rawGet.call(localStorage, key);
        const items = decodeEntries(remote);
        let merged;

        if (key === BOOKINGS) {
            const map = new Map();
            readJSON(key, []).forEach(b => map.set(String(b.id), b));
            Object.entries(items).forEach(([id, b]) => map.set(String(id), b));
            merged = [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
        } else if (key === USERS) {
            const list = readJSON(key, []);
            Object.values(items).forEach(profile => {
                const i = list.findIndex(u => lower(u.email) === lower(profile.email));
                if (i >= 0) list[i] = { ...list[i], ...profile };   // nananatili ang lokal na password para sa migration
                else list.push({ ...profile });
            });
            merged = list;
        } else {
            merged = { ...readJSON(key, {}), ...items };
        }

        const after = JSON.stringify(merged);
        if (after === before) return false;
        rawSet.call(localStorage, key, after);
        return true;
    }

    /* ================= PUSH ================= */
    async function push(key, text) {
        const entries = buildEntries(key, text);
        if (!entries || !Object.keys(entries).length) return;

        pendingPushes += 1;
        try {
            const token = await CloudAuth.token();
            if (!token) return;                    // hindi naka-login: lokal lang muna
            const res = await fetch(urlFor(key, token), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(entries)
            });
            if (!res.ok) console.warn("[cloud-sync] Hindi na-save sa cloud:", key, res.status);
        } catch (err) {
            console.warn("[cloud-sync] Hindi ma-push:", key, err);
        } finally {
            pendingPushes -= 1;
        }
    }

    Storage.prototype.setItem = function (key, value) {
        rawSet.call(this, key, value);
        if (this === localStorage && syncedKeys.includes(key)) push(key, value);
    };

    function pushAll() {
        syncedKeys.forEach(key => {
            const text = rawGet.call(localStorage, key);
            if (text) push(key, text);
        });
    }

    /* ================= PULL ================= */
    // Sabay (synchronous) sa pag-load, para nandoon na ang data bago mag-run ang script.js
    function pullAllSync() {
        const token = CloudAuth.tokenSync();
        syncedKeys.forEach(key => {
            if (isPrivate(key) && !token) return;
            try {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", urlFor(key, isPrivate(key) ? token : null), false);
                xhr.send();
                if (xhr.status === 200 && xhr.responseText && xhr.responseText !== "null") {
                    applyRemote(key, JSON.parse(xhr.responseText));
                }
            } catch (err) {
                console.warn("[cloud-sync] Hindi ma-pull:", key, err);
            }
        });
    }

    // Hanapin ang isang profile sa cloud (para sa login sa bagong device)
    function pullProfileSync(email) {
        try {
            const key = encodeKey(lower(email));
            const xhr = new XMLHttpRequest();
            xhr.open("GET", `${base}/profiles/${encodeURIComponent(key)}.json`, false);
            xhr.send();
            if (xhr.status === 200 && xhr.responseText && xhr.responseText !== "null") {
                applyRemote(USERS, { [key]: JSON.parse(xhr.responseText) });
                return true;
            }
        } catch (err) {
            console.warn("[cloud-sync] Hindi ma-pull ang profile:", err);
        }
        return false;
    }

    function refreshScreens() {
        if (typeof syncHomepageProviderCards === "function") syncHomepageProviderCards();
        if (typeof applyProviderFilters === "function") applyProviderFilters();
        if (typeof updateHeroStats === "function") updateHeroStats();

        const user = typeof getCurrentUser === "function" ? getCurrentUser() : null;
        const shown = id => { const el = document.getElementById(id); return el && el.style.display === "block"; };
        if (user && user.role === "Customer" && shown("userDashboard") && typeof renderCustomerBookings === "function") renderCustomerBookings();
        if (user && user.role === "Service Provider" && shown("providerDashboard") && typeof renderProviderRequests === "function") renderProviderRequests();

        const modal = document.getElementById("profileModal");
        if (modal && modal.style.display === "flex" && typeof currentProvider !== "undefined" && currentProvider && typeof viewProvider === "function") {
            viewProvider(currentProvider);
        }
    }

    async function poll() {
        if (pendingPushes > 0) return;             // may sine-save pa, huwag munang i-overwrite
        const token = await CloudAuth.token();
        let changed = false;

        for (const key of syncedKeys) {
            if (isPrivate(key) && !token) continue;
            try {
                const res = await fetch(urlFor(key, isPrivate(key) ? token : null));
                if (!res.ok) continue;
                const data = await res.json();
                if (data && applyRemote(key, data)) changed = true;
            } catch { /* offline, subukan ulit mamaya */ }
        }
        if (changed) refreshScreens();
    }

    // Tawagin pagkatapos mag-login: kunin muna ang cloud data, saka i-upload ang lokal na wala pa doon
    async function syncNow() {
        await poll();
        pushAll();
    }

    window.CloudAuth = CloudAuth;
    window.CloudSync = { refresh: poll, syncNow, pullProfileSync };

    pullAllSync();
    setInterval(poll, cfg.pollMs);
})();

/* =========================================================
   FIREBASE SETUP (isang beses lang)
   1) Firebase Console > Add project.
   2) Build > Authentication > Get started > Sign-in method >
      i-enable ang "Email/Password".
   3) Build > Realtime Database > Create Database. Kopyahin ang URL
      papunta sa databaseUrl sa itaas.
   4) Project settings > General > "Web API Key" papunta sa apiKey.
   5) Realtime Database > Rules, i-paste ito at i-Publish:

   {
     "rules": {
       "profinder": {
         "profiles":                   { ".read": true,          ".write": "auth != null" },
         "profinderSpecialists":       { ".read": true,          ".write": "auth != null" },
         "profinderJoinedSpecialists": { ".read": true,          ".write": "auth != null" },
         "profinderGeneralReviews":    { ".read": true,          ".write": "auth != null" },
         "profinderSpecialistReviews": { ".read": true,          ".write": "auth != null" },
         "profinderBookings":          { ".read": "auth != null", ".write": "auth != null" }
       }
     }
   }
========================================================= */


/* ======================= ORIGINAL SCRIPT.JS (walang binago) ======================= */

/* =========================================================
   PROFINDER - UNIFIED FRONT-END JAVASCRIPT (DOM + API)
========================================================= */

const USERS_KEY = "profinderUsers";
const SESSION_KEY = "profinderCurrentUser";
const FAVORITES_KEY = "profinderFavorites";
const BOOKINGS_KEY = "profinderBookings";
const GENERAL_REVIEWS_KEY = "profinderGeneralReviews";
const SPECIALIST_REVIEWS_KEY = "profinderSpecialistReviews";
const SPECIALISTS_KEY = "profinderSpecialists";
const JOINED_SPECIALISTS_KEY = "profinderJoinedSpecialists";

// Replace these 3 values with your EmailJS credentials for direct background email delivery
const EMAILJS_CONFIG = {
    serviceId: "YOUR_SERVICE_ID",
    templateId: "YOUR_TEMPLATE_ID",
    publicKey: "YOUR_PUBLIC_KEY",
    // Separate EmailJS template used for the 6-digit login code (see {{to_email}} and {{otp_code}})
    otpTemplateId: "YOUR_OTP_TEMPLATE_ID"
};

// Comprehensive List of Cities & Mini-Cities (Municipalities) for the Location Picker
const AVAILABLE_LOCATIONS = [
    // Major & Component Cities
    { name: "Batangas City", type: "City", province: "Batangas" },
    { name: "Lipa City", type: "City", province: "Batangas" },
    { name: "Tanauan City", type: "City", province: "Batangas" },
    { name: "Santo Tomas City", type: "City", province: "Batangas" },
    { name: "Calaca City", type: "City", province: "Batangas" },
    { name: "Calamba City", type: "City", province: "Laguna" },
    { name: "Santa Rosa City", type: "City", province: "Laguna" },
    { name: "Tagaytay City", type: "City", province: "Cavite" },

    // Mini-Cities / Municipalities
    { name: "Malvar", type: "Mini-City", province: "Batangas" },
    { name: "Bauan", type: "Mini-City", province: "Batangas" },
    { name: "Mabini", type: "Mini-City", province: "Batangas" },
    { name: "San Jose", type: "Mini-City", province: "Batangas" },
    { name: "Ibaan", type: "Mini-City", province: "Batangas" },
    { name: "Rosario", type: "Mini-City", province: "Batangas" },
    { name: "San Juan", type: "Mini-City", province: "Batangas" },
    { name: "Padre Garcia", type: "Mini-City", province: "Batangas" },
    { name: "Lemery", type: "Mini-City", province: "Batangas" },
    { name: "Taal", type: "Mini-City", province: "Batangas" },
    { name: "Nasugbu", type: "Mini-City", province: "Batangas" },
    { name: "Balayan", type: "Mini-City", province: "Batangas" },
    { name: "Cuenca", type: "Mini-City", province: "Batangas" },
    { name: "Alitagtag", type: "Mini-City", province: "Batangas" },
    { name: "Mataasnakahoy", type: "Mini-City", province: "Batangas" },
    { name: "Talisay", type: "Mini-City", province: "Batangas" },
    { name: "Laurel", type: "Mini-City", province: "Batangas" },
    { name: "Agoncillo", type: "Mini-City", province: "Batangas" },
    { name: "Santa Teresita", type: "Mini-City", province: "Batangas" },
    { name: "San Luis", type: "Mini-City", province: "Batangas" },
    { name: "San Nicolas", type: "Mini-City", province: "Batangas" },
    { name: "Calatagan", type: "Mini-City", province: "Batangas" },
    { name: "Lian", type: "Mini-City", province: "Batangas" },
    { name: "Tuy", type: "Mini-City", province: "Batangas" },
    { name: "Lobo", type: "Mini-City", province: "Batangas" },
    { name: "Taysan", type: "Mini-City", province: "Batangas" },
    { name: "Tingloy", type: "Mini-City", province: "Batangas" }
];

// Detailed Service Categories + Independent Specialists (6 Core + 4 New Specialties with 0 Pre-Added Reviews)
const DEFAULT_PROVIDERS = [
    {
        businessName: "TechFix Solutions",
        ownerName: "James Aldrei",
        theme: "theme-blue",
        email: "24-06547@g.batstate-u.edu.ph",
        password: "password123",
        providerCategory: "Computer",
        serviceTitle: "Computer Repair, Software & IT Support",
        availability: "Mon - Sat, 8:00 AM - 6:00 PM",
        providerDescription: "Independent hardware repair technicians, software developers, and network specialists.",
        generalReviews: [
            { client: "Angela Mendoza", rating: 5, date: "Nov 12, 2026", comment: "Kumpleto ang IT at computer services dito, madaling makahanap ng technician." },
            { client: "Paolo Ramirez", rating: 5, date: "Oct 28, 2026", comment: "Transparent ang pricing at mabilis mag-confirm ng schedule." }
        ],
        specialists: [
            {
                name: "James Aldrei",
                company: "Aldrei IT & Software Solutions",
                specialty: "Full-Stack System, Laptop Repair & Diagnostics",
                price: 500,
                priceUnit: "service",
                age: 21,
                gender: "Male",
                address: "Alangilan, Batangas City",
                city: "Batangas City",
                contact: "0991-691-9268",
                email: "24-06547@g.batstate-u.edu.ph",
                photo: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "BatStateU IT Specialist — Laptop, PC & Software Troubleshooting",
                    "Fast Email & SMS booking response with full diagnostic report"
                ],
                reviews: [
                    {
                        client: "Carl Vincent Dimaano",
                        rating: 5,
                        date: "Nov 18, 2026",
                        comment: "Sobrang galing at bilis ni James Aldrei! Naayos agad ang boot loop at software setup ng laptop ko.",
                        proofPhoto: "https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Laptop OS recovery & hardware optimization"
                    }
                ]
            },
            {
                name: "Mark Anthony Reyes",
                company: "Reyes Hardware & PC Clinic",
                specialty: "Laptop & Motherboard Repair",
                price: 550,
                priceUnit: "service",
                age: 26,
                gender: "Male",
                address: "Kumintang Ilaya, Batangas City",
                city: "Batangas City",
                contact: "0917-842-1101",
                email: "reyes.pcclinic@profinder.com",
                photo: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "6 years experience in laptop & desktop hardware repair",
                    "Expert on motherboard diagnostics, SSD upgrades & OS recovery"
                ],
                reviews: [
                    {
                        client: "Angela Mendoza",
                        rating: 5,
                        date: "Nov 12, 2026",
                        comment: "Na-upgrade ni Mark sa SSD ang laptop ko at nalinis ang fan. Ang bilis na mag-boot!",
                        proofPhoto: "https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Laptop SSD upgrade & internal cleaning"
                    }
                ]
            },
            {
                name: "Kyla Mae Soriano",
                company: "Soriano NetWorks IT Services",
                specialty: "Wi-Fi Setup, OS & Virus Removal",
                price: 750,
                priceUnit: "service",
                age: 23,
                gender: "Female",
                address: "Alangilan, Batangas City",
                city: "Batangas City",
                contact: "0926-519-8834",
                email: "kyla.networks@profinder.com",
                photo: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Network & Wi-Fi router configuration specialist",
                    "Software installation, virus removal & data backup"
                ],
                reviews: [
                    {
                        client: "Paolo Ramirez",
                        rating: 5,
                        date: "Oct 28, 2026",
                        comment: "Inayos ni Kyla ang mesh Wi-Fi namin sa bahay kaya abot na hanggang 2nd floor ang signal.",
                        proofPhoto: "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Dual-band mesh router installation"
                    }
                ]
            }
        ]
    },
    {
        businessName: "QuickFix Home Repair",
        ownerName: "Ramon Bautista",
        theme: "theme-red",
        email: "quickfix@profinder.com",
        password: "password123",
        providerCategory: "Home Repair",
        serviceTitle: "Plumbing, Electrical & Home Maintenance",
        availability: "Mon - Sat, 8:00 AM - 5:00 PM",
        providerDescription: "Independent plumbing and electrical specialists from verified local companies.",
        generalReviews: [
            { client: "Erwin Castillo", rating: 5, date: "Nov 16, 2026", comment: "Napakadaling mag-book ng home repair dito sa ProFinder, mabilis ang response." },
            { client: "Maricel Hernandez", rating: 4, date: "Nov 04, 2026", comment: "Maganda na may hiwalay na plumbing at electrical companies na mapagpipilian." }
        ],
        specialists: [
            {
                name: "John Lexter Villena",
                company: "Villena Plumbing & Pipe Works",
                specialty: "Plumbing & Leak Repair",
                price: 600,
                priceUnit: "visit",
                age: 20,
                gender: "Male",
                address: "Dalig, Batangas City",
                city: "Batangas City",
                contact: "0992-333-4550",
                email: "villena.plumbing@profinder.com",
                photo: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Have 20 year's experience",
                    "Expert on plumbing"
                ],
                reviews: [
                    {
                        client: "Erwin Castillo",
                        rating: 5,
                        date: "Nov 16, 2026",
                        comment: "Agad naayos ni John Lexter ang malakas na tagas sa ilalim ng lababo namin. Pulido ang pagkakabit ng bagong tubo!",
                        proofPhoto: "https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Repaired kitchen sink pipe & valve"
                    },
                    {
                        client: "Rowena Magtibay",
                        rating: 5,
                        date: "Nov 02, 2026",
                        comment: "Walang tulo at malinis magtrabaho. Sulit ang bayad.",
                        proofPhoto: "https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Bathroom water line installation"
                    }
                ]
            },
            {
                name: "Ivy Gwen Asensi",
                company: "Asensi Electrical & Lighting Corp.",
                specialty: "Electrical Wiring & Breaker Repair",
                price: 850,
                priceUnit: "visit",
                age: 19,
                gender: "Female",
                address: "Poblacion, Malvar",
                city: "Malvar",
                contact: "0918-442-1900",
                email: "asensi.electrical@profinder.com",
                photo: "https://images.unsplash.com/photo-1595814433015-e6f5ce69614e?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Certified residential electrician & lighting installer",
                    "Fast home outlet & circuit breaker troubleshooting"
                ],
                reviews: [
                    {
                        client: "Maricel Hernandez",
                        rating: 4,
                        date: "Nov 04, 2026",
                        comment: "Na-troubleshoot agad ni Ivy ang nagti-trip naming circuit breaker at pinalitan ang siraing outlet.",
                        proofPhoto: "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Replaced circuit breaker & tested voltage"
                    }
                ]
            }
        ]
    },
    {
        businessName: "Glow Beauty Studio",
        ownerName: "Carla Mendoza",
        theme: "theme-gold",
        email: "glowbeauty@profinder.com",
        password: "password123",
        providerCategory: "Beauty",
        serviceTitle: "Hair, Makeup & Home Spa Services",
        availability: "Tue - Sun, 9:00 AM - 7:00 PM",
        providerDescription: "Independent freelance makeup artists, hairstylists, and aestheticians.",
        generalReviews: [
            { client: "Trisha Evangelista", rating: 5, date: "Nov 10, 2026", comment: "Super convenient mag-book ng home service beauty specialists!" },
            { client: "Katrina Robles", rating: 5, date: "Oct 21, 2026", comment: "May picture proof talaga ng gawa nila kaya panatag magpa-book." }
        ],
        specialists: [
            {
                name: "Carla Jane Mendoza",
                company: "Carla Glam & Bridal Artistry",
                specialty: "Event Makeup & Hair Styling",
                price: 650,
                priceUnit: "session",
                age: 25,
                gender: "Female",
                address: "Darasa, Tanauan City",
                city: "Tanauan City",
                contact: "0920-415-3309",
                email: "carla.glam@profinder.com",
                photo: "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "7 years experience as bridal & event makeup artist",
                    "Expert on hair styling, rebond & keratin treatment"
                ],
                reviews: [
                    {
                        client: "Trisha Evangelista",
                        rating: 5,
                        date: "Nov 10, 2026",
                        comment: "Fresh at long-lasting ang makeup ko hanggang matapos ang reception. Salamat Ms. Carla!",
                        proofPhoto: "https://images.unsplash.com/photo-1487412947147-5cebf100ffc2?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Finished soft-glam event makeup & curls"
                    }
                ]
            },
            {
                name: "Shiela Marie Ramos",
                company: "Shiela Nail & Facial Lounge",
                specialty: "Facial Spa & Gel Manicure/Pedicure",
                price: 450,
                priceUnit: "session",
                age: 22,
                gender: "Female",
                address: "Sambal, Tanauan City",
                city: "Tanauan City",
                contact: "0935-882-1047",
                email: "shiela.nails@profinder.com",
                photo: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Licensed aesthetician & nail care technician",
                    "Specializes in facial spa, gel manicure & foot spa"
                ],
                reviews: [
                    {
                        client: "Katrina Robles",
                        rating: 5,
                        date: "Oct 21, 2026",
                        comment: "Ang linis ng gel manicure at nakakarelax ang home service foot spa ni Shiela.",
                        proofPhoto: "https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Completed gel manicure home service"
                    }
                ]
            }
        ]
    },
    {
        businessName: "CleanHome Services",
        ownerName: "Ana Santos",
        theme: "theme-green",
        email: "cleanhome@profinder.com",
        password: "password123",
        providerCategory: "Cleaning",
        serviceTitle: "Home & Office Deep Cleaning",
        availability: "Daily, 7:00 AM - 5:00 PM",
        providerDescription: "Independent home housekeeping and upholstery cleaning companies.",
        generalReviews: [
            { client: "Clarissa Dimaano", rating: 5, date: "Nov 15, 2026", comment: "Maaasahan ang cleaning providers dito, on-time at kumpleto sa gamit." },
            { client: "Bryan Magboo", rating: 5, date: "Nov 02, 2026", comment: "Madaling makita ang presyo at specialty ng bawat cleaning company." }
        ],
        specialists: [
            {
                name: "Ana Liza Santos",
                company: "Santos Sparkle Housekeeping",
                specialty: "Condo & Home Deep Cleaning",
                price: 800,
                priceUnit: "session",
                age: 29,
                gender: "Female",
                address: "Sabang, Lipa City",
                city: "Lipa City",
                contact: "0918-630-2204",
                email: "analiza.clean@profinder.com",
                photo: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "8 years experience in residential & office housekeeping",
                    "Expert on deep kitchen & bathroom sanitization"
                ],
                reviews: [
                    {
                        client: "Clarissa Dimaano",
                        rating: 5,
                        date: "Nov 15, 2026",
                        comment: "Sobrang linis at bango ng condo unit namin pagkatapos ng deep cleaning ni Ana Liza.",
                        proofPhoto: "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Sanitized kitchen & living area"
                    }
                ]
            },
            {
                name: "Jomar Dalisay",
                company: "Dalisay Upholstery & Sofa Care",
                specialty: "Sofa, Mattress & Carpet Shampooing",
                price: 1200,
                priceUnit: "session",
                age: 24,
                gender: "Male",
                address: "Marawoy, Lipa City",
                city: "Lipa City",
                contact: "0916-992-3410",
                email: "jomar.upholstery@profinder.com",
                photo: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Upholstery, sofa & mattress vacuum shampoo specialist",
                    "Post-construction & heavy-duty cleanup expert"
                ],
                reviews: [
                    {
                        client: "Bryan Magboo",
                        rating: 5,
                        date: "Nov 02, 2026",
                        comment: "Parang bago ulit ang 3-seater sofa namin, tanggal lahat ng mantsa!",
                        proofPhoto: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Deep vacuumed & shampooed living room sofa"
                    }
                ]
            }
        ]
    },
    {
        businessName: "StudySmart Tutorial",
        ownerName: "Jerome Cruz",
        theme: "theme-purple",
        email: "studysmart@profinder.com",
        password: "password123",
        providerCategory: "Tutoring",
        serviceTitle: "Academic & Coding Tutoring",
        availability: "Mon - Fri, 3:00 PM - 8:00 PM",
        providerDescription: "Independent academic tutors and coding instructors from different tutorial centers.",
        generalReviews: [
            { client: "Mrs. Lourdes Garcia", rating: 5, date: "Nov 14, 2026", comment: "Magagaling at licensed ang mga tutors sa category na ito." },
            { client: "Daniel Perez", rating: 5, date: "Oct 30, 2026", comment: "Mabilis mag-reply at flexible sa afternoon schedule." }
        ],
        specialists: [
            {
                name: "Jerome Patrick Cruz",
                company: "Cruz Math & Coding Hub",
                specialty: "Mathematics, Physics & Programming",
                price: 450,
                priceUnit: "hour",
                age: 24,
                gender: "Male",
                address: "Pallocan West, Batangas City",
                city: "Batangas City",
                contact: "0919-774-4412",
                email: "jerome.tutor@profinder.com",
                photo: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "5 years experience teaching Mathematics & Physics",
                    "Expert on Python, Java & Web Development tutoring"
                ],
                reviews: [
                    {
                        client: "Mrs. Lourdes Garcia",
                        rating: 5,
                        date: "Nov 14, 2026",
                        comment: "Tumaas ang quiz scores ng anak ko sa Algebra at Python dahil kay Sir Jerome.",
                        proofPhoto: "https://images.unsplash.com/photo-1434030216411-0b793f4b4173?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — 1-on-1 Algebra & Python coaching session"
                    }
                ]
            },
            {
                name: "Bianca Rose Mercado",
                company: "Mercado English & Science Study Center",
                specialty: "English, Science & Elementary Coaching",
                price: 350,
                priceUnit: "hour",
                age: 22,
                gender: "Female",
                address: "Gulod Labac, Batangas City",
                city: "Batangas City",
                contact: "0945-710-2289",
                email: "bianca.study@profinder.com",
                photo: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Licensed Professional Teacher (English & Science)",
                    "Patient elementary & high school homework coach"
                ],
                reviews: [
                    {
                        client: "Daniel Perez",
                        rating: 5,
                        date: "Oct 30, 2026",
                        comment: "Very patient magturo si Teacher Bianca sa English reading comprehension ng kapatid ko.",
                        proofPhoto: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Completed English & Science workbook review"
                    }
                ]
            }
        ]
    },
    {
        businessName: "SafeRide Transport",
        ownerName: "Leo Villanueva",
        theme: "theme-teal",
        email: "saferide@profinder.com",
        password: "password123",
        providerCategory: "Transportation",
        serviceTitle: "Local & Airport Transportation",
        availability: "24/7 Advance Booking",
        providerDescription: "Independent car rental drivers and cargo transport operators.",
        generalReviews: [
            { client: "Dennis Macatangay", rating: 5, date: "Nov 11, 2026", comment: "Safe at on-time ang transport providers dito sa Batangas." },
            { client: "Jessa Alcantara", rating: 5, date: "Oct 25, 2026", comment: "May sedan at L300 van options depende sa kailangan mo." }
        ],
        specialists: [
            {
                name: "Leo Carlo Villanueva",
                company: "Villanueva Sedan & Airport Transfers",
                specialty: "City Rides & NAIA Airport Drop-off",
                price: 400,
                priceUnit: "base trip",
                age: 34,
                gender: "Male",
                address: "Bolbok, Batangas City",
                city: "Batangas City",
                contact: "0927-318-6620",
                email: "leo.saferide@profinder.com",
                photo: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "12 years professional defensive driving experience",
                    "Expert on NAIA airport transfers & Batangas-Manila trips"
                ],
                reviews: [
                    {
                        client: "Dennis Macatangay",
                        rating: 5,
                        date: "Nov 11, 2026",
                        comment: "Nakarating kami sa NAIA Terminal 3 nang maaga at safe. Malinis at malamig ang aircon ng kotse.",
                        proofPhoto: "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Completed Batangas to NAIA airport transfer"
                    }
                ]
            },
            {
                name: "Noel Magpantay",
                company: "Magpantay L300 Lipat-Bahay & Cargo",
                specialty: "L300 Van Lipat-Bahay & Cargo Delivery",
                price: 1500,
                priceUnit: "base trip",
                age: 31,
                gender: "Male",
                address: "Sta. Rita, Batangas City",
                city: "Batangas City",
                contact: "0908-664-9120",
                email: "noel.cargo@profinder.com",
                photo: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "L300 & utility van driver for lipat-bahay & cargo",
                    "Familiar with all Calabarzon routes"
                ],
                reviews: [
                    {
                        client: "Jessa Alcantara",
                        rating: 5,
                        date: "Oct 25, 2026",
                        comment: "Maingat na nailipat lahat ng appliances at boxes namin gamit ang L300 van ni Kuya Noel.",
                        proofPhoto: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=500&q=80",
                        proofCaption: "Served Properly — Completed lipat-bahay cargo transport"
                    }
                ]
            }
        ]
    },

    /* ================= 4 NEW SPECIALTIES (NO PRE-ADDED REVIEWS) ================= */
    {
        businessName: "CoolBreeze Aircon & Appliance Care",
        ownerName: "Renato Manalo",
        theme: "theme-blue",
        email: "coolbreeze@profinder.com",
        password: "password123",
        providerCategory: "Appliance Repair",
        serviceTitle: "Aircon Cleaning, Freon Recharge & Home Appliance Repair",
        availability: "Mon - Sun, 8:00 AM - 6:00 PM",
        providerDescription: "Certified HVAC technicians and refrigerator/washing machine repair specialists.",
        generalReviews: [],
        specialists: [
            {
                name: "Renato Luis Manalo",
                company: "Manalo HVAC & Aircon Cleaning",
                specialty: "Split & Window Aircon Cleaning and Freon Recharge",
                price: 700,
                priceUnit: "unit",
                age: 32,
                gender: "Male",
                address: "Poblacion, Bauan",
                city: "Bauan",
                contact: "0917-410-8821",
                email: "renato.aircon@profinder.com",
                photo: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "TESDA RAC NC II Certified Aircon Technician",
                    "Specializes in inverter aircon chemical wash & leak repair"
                ],
                reviews: []
            },
            {
                name: "Giselle Mae Dimaculangan",
                company: "Dimaculangan Ref & Washer Clinic",
                specialty: "Refrigerator & Washing Machine Repair",
                price: 650,
                priceUnit: "visit",
                age: 27,
                gender: "Female",
                address: "San Roque, Santo Tomas City",
                city: "Santo Tomas City",
                contact: "0928-551-9043",
                email: "giselle.appliance@profinder.com",
                photo: "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "5 years experience repairing inverter refrigerators & automatic washers",
                    "On-site home diagnostics with genuine spare parts"
                ],
                reviews: []
            }
        ]
    },
    {
        businessName: "PawFect Pet Grooming & Care",
        ownerName: "Clarisse Joy Reyes",
        theme: "theme-gold",
        email: "pawfect@profinder.com",
        password: "password123",
        providerCategory: "Pet Care",
        serviceTitle: "Home Service Pet Grooming, Bathing & Pet Sitting",
        availability: "Tue - Sun, 9:00 AM - 6:00 PM",
        providerDescription: "Gentle, stress-free mobile pet grooming and trusted pet care sitters.",
        generalReviews: [],
        specialists: [
            {
                name: "Clarisse Joy Reyes",
                company: "PawFect Mobile Pet Salon",
                specialty: "Full Dog & Cat Grooming, Nail Trim & Ear Cleaning",
                price: 550,
                priceUnit: "session",
                age: 25,
                gender: "Female",
                address: "Banaybanay, San Jose",
                city: "San Jose",
                contact: "0919-302-7745",
                email: "clarisse.pawfect@profinder.com",
                photo: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Certified professional pet stylist for small to large breeds",
                    "Uses hypoallergenic pet shampoos & sanitized grooming tools"
                ],
                reviews: []
            },
            {
                name: "Marco Paolo Mendoza",
                company: "Mendoza Pet Sitter & Dog Walking",
                specialty: "Daily Dog Walking & Overnight Pet Sitting",
                price: 400,
                priceUnit: "day",
                age: 24,
                gender: "Male",
                address: "Balintawak, Lipa City",
                city: "Lipa City",
                contact: "0936-814-2290",
                email: "marco.petsitter@profinder.com",
                photo: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Experienced pet handler with regular photo/video updates",
                    "Safe neighborhood walks & feeding schedule care"
                ],
                reviews: []
            }
        ]
    },
    {
        businessName: "LensCraft Events & Photography",
        ownerName: "Adrian Kyle Flores",
        theme: "theme-purple",
        email: "lenscraft@profinder.com",
        password: "password123",
        providerCategory: "Events & Photography",
        serviceTitle: "Birthday, Wedding, Portrait Photography & Video Coverage",
        availability: "Daily, By Appointment",
        providerDescription: "Creative local photographers and event videographers for memorable occasions.",
        generalReviews: [],
        specialists: [
            {
                name: "Adrian Kyle Flores",
                company: "Flores Visuals & Event Studio",
                specialty: "Birthday, Debut & Beach Portrait Photography",
                price: 2500,
                priceUnit: "package",
                age: 26,
                gender: "Male",
                address: "Wawa, Nasugbu",
                city: "Nasugbu",
                contact: "0915-774-6318",
                email: "adrian.lenscraft@profinder.com",
                photo: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Full-frame DSLR & mirrorless event photographer",
                    "Fast turnaround of high-resolution color-graded photos"
                ],
                reviews: []
            },
            {
                name: "Sophia Marie Alcantara",
                company: "Alcantara Heritage Films & Photo",
                specialty: "Wedding Videography & Same-Day Edit Reels",
                price: 3500,
                priceUnit: "package",
                age: 24,
                gender: "Female",
                address: "Poblacion, Taal",
                city: "Taal",
                contact: "0927-904-1182",
                email: "sophia.films@profinder.com",
                photo: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Cinematic 4K event coverage & social media highlight reels",
                    "Experienced in heritage church & garden events in Taal"
                ],
                reviews: []
            }
        ]
    },
    {
        businessName: "MotoCare & Auto Mechanics",
        ownerName: "Dante Navarro",
        theme: "theme-teal",
        email: "motocare@profinder.com",
        password: "password123",
        providerCategory: "Auto Repair",
        serviceTitle: "Home-Service Car & Motorcycle Tune-Up, Battery & Brake Repair",
        availability: "Mon - Sun, 7:00 AM - 7:00 PM",
        providerDescription: "On-call automotive mechanics and motorcycle PMS specialists.",
        generalReviews: [],
        specialists: [
            {
                name: "Dante Vergara Navarro",
                company: "Navarro Mobile Auto Clinic",
                specialty: "Car Change Oil, Battery Jumpstart & Brake Service",
                price: 800,
                priceUnit: "service",
                age: 35,
                gender: "Male",
                address: "Poblacion, Rosario",
                city: "Rosario",
                contact: "0918-920-4415",
                email: "dante.autoclinic@profinder.com",
                photo: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "10 years automotive mechanic & OBD2 engine scanner diagnostics",
                    "Emergency roadside & home driveway car maintenance"
                ],
                reviews: []
            },
            {
                name: "Rico Jay Evangelista",
                company: "Evangelista MotoWorks & CVT Tuning",
                specialty: "Motorcycle FI Cleaning, CVT Tuning & Oil Change",
                price: 450,
                priceUnit: "service",
                age: 27,
                gender: "Male",
                address: "Bagong Sikat, Lemery",
                city: "Lemery",
                contact: "0909-643-8871",
                email: "rico.motoworks@profinder.com",
                photo: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=300&q=80",
                bio: [
                    "Scooter & underbone motorcycle PMS and wiring specialist",
                    "Home service tune-up across Lemery and nearby towns"
                ],
                reviews: []
            }
        ]
    }
];

let currentProvider = "";
let currentSpecialist = "";
let currentSpecialistObj = null;
let selectedBookingChannel = "email";
let activeReviewProviderName = "";
let activeReviewSpecialistName = "";
let pendingProofDataUrl = "";

/* ================= CITIES & MINI-CITIES PICKER ================= */
function renderLocationDropdown(filterText = "") {
    const dropdown = document.getElementById("locationDropdown");
    if (!dropdown) return;

    const query = filterText.trim().toLowerCase();
    const currentVal = (document.getElementById("locationInput")?.value || "").trim().toLowerCase();

    const filtered = AVAILABLE_LOCATIONS.filter(loc =>
        !query ||
        loc.name.toLowerCase().includes(query) ||
        loc.type.toLowerCase().includes(query) ||
        loc.province.toLowerCase().includes(query)
    );

    const cities = filtered.filter(l => l.type === "City");
    const miniCities = filtered.filter(l => l.type === "Mini-City");

    let html = `
        <button type="button"
                class="loc-option-item ${!currentVal ? "selected" : ""}"
                onclick="selectLocationOption('')">
            <span class="loc-option-left">
                <i class="fa-solid fa-globe"></i>
                <span>All Cities & Mini-Cities</span>
            </span>
            <span class="loc-type-badge">All</span>
        </button>
    `;

    if (cities.length) {
        html += `<div class="loc-group-header">Cities (${cities.length})</div>`;
        html += cities.map(loc => `
            <button type="button"
                    class="loc-option-item ${currentVal === loc.name.toLowerCase() ? "selected" : ""}"
                    onclick="selectLocationOption('${escapeAttr(loc.name)}')">
                <span class="loc-option-left">
                    <i class="fa-solid fa-city"></i>
                    <span>${escapeHTML(loc.name)}</span>
                </span>
                <span class="loc-type-badge city">${escapeHTML(loc.province)}</span>
            </button>
        `).join("");
    }

    if (miniCities.length) {
        html += `<div class="loc-group-header">Mini-Cities / Municipalities (${miniCities.length})</div>`;
        html += miniCities.map(loc => `
            <button type="button"
                    class="loc-option-item ${currentVal === loc.name.toLowerCase() ? "selected" : ""}"
                    onclick="selectLocationOption('${escapeAttr(loc.name)}')">
                <span class="loc-option-left">
                    <i class="fa-solid fa-location-dot"></i>
                    <span>${escapeHTML(loc.name)}</span>
                </span>
                <span class="loc-type-badge mini">Mini-City</span>
            </button>
        `).join("");
    }

    if (!cities.length && !miniCities.length) {
        html += `<div class="loc-empty-msg">No matching city or town for "${escapeHTML(filterText)}"</div>`;
    }

    dropdown.innerHTML = html;
}

function openLocationDropdown() {
    const inputVal = document.getElementById("locationInput")?.value || "";
    renderLocationDropdown(inputVal);
    document.getElementById("locationDropdown")?.classList.add("open");
}

function closeLocationDropdown() {
    document.getElementById("locationDropdown")?.classList.remove("open");
}

function toggleLocationDropdown() {
    const dropdown = document.getElementById("locationDropdown");
    if (!dropdown) return;
    if (dropdown.classList.contains("open")) {
        closeLocationDropdown();
    } else {
        openLocationDropdown();
        document.getElementById("locationInput")?.focus();
    }
}

function selectLocationOption(locationName) {
    const input = document.getElementById("locationInput");
    if (input) input.value = locationName;
    closeLocationDropdown();
    searchProviders();
}

function handleLocationTyping() {
    const val = document.getElementById("locationInput")?.value || "";
    renderLocationDropdown(val);
    document.getElementById("locationDropdown")?.classList.add("open");
    searchProviders();
}

function clearLocationInput() {
    const input = document.getElementById("locationInput");
    if (input) input.value = "";
    renderLocationDropdown("");
    searchProviders();
}

function clearServiceInput() {
    const input = document.getElementById("searchInput");
    if (input) input.value = "";
    searchProviders();
}

/* ================= STORAGE HELPERS ================= */
function getUsers() {
    try {
        return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
    } catch {
        return [];
    }
}

function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function getCustomGeneralReviews() {
    try {
        return JSON.parse(localStorage.getItem(GENERAL_REVIEWS_KEY)) || {};
    } catch {
        return {};
    }
}

function saveCustomGeneralReviews(reviewsMap) {
    localStorage.setItem(GENERAL_REVIEWS_KEY, JSON.stringify(reviewsMap));
}

function getCustomSpecialistReviews() {
    try {
        return JSON.parse(localStorage.getItem(SPECIALIST_REVIEWS_KEY)) || {};
    } catch {
        return {};
    }
}

function saveCustomSpecialistReviews(reviewsMap) {
    localStorage.setItem(SPECIALIST_REVIEWS_KEY, JSON.stringify(reviewsMap));
}

function makeSpecialistKey(providerName, specialistName) {
    return `${String(providerName).trim().toLowerCase()}::${String(specialistName).trim().toLowerCase()}`;
}

function seedDefaultProviderAccounts() {
    const users = getUsers();
    let changed = false;

    DEFAULT_PROVIDERS.forEach(p => {
        if (!users.some(u => u.email === p.email)) {
            users.push({
                name: p.ownerName,
                email: p.email,
                phone: p.specialists?.[0]?.contact || "0917-555-0100",
                role: "Service Provider",
                password: p.password,
                businessName: p.businessName,
                providerCategory: p.providerCategory,
                providerLocation: calculateProviderLocations(p),
                providerDescription: p.providerDescription,
                availability: p.availability
            });
            changed = true;
        }
    });

    if (changed) saveUsers(users);
}

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
        return null;
    }
}

function setCurrentUser(user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

function getBookings() {
    try {
        return JSON.parse(localStorage.getItem(BOOKINGS_KEY)) || [];
    } catch {
        return [];
    }
}

function saveBookings(items) {
    localStorage.setItem(BOOKINGS_KEY, JSON.stringify(items));
}

function getProviderBusiness(user) {
    return user?.businessName || user?.name || "Service Provider";
}

function getAllProvidersData() {
    const registeredProviders = getUsers()
        .filter(u => u.role === "Service Provider" && u.businessName)
        .map(u => ({
            businessName: u.businessName,
            ownerName: u.name,
            theme: "theme-blue",
            email: u.email,
            providerCategory: u.providerCategory || "General",
            serviceTitle: u.providerCategory || "Local Service",
            availability: u.availability || "Mon - Sat, 9:00 AM - 5:00 PM",
            providerDescription: u.providerDescription || "Trusted local service provider on ProFinder.",
            generalReviews: [],
            specialists: [
                {
                    name: u.name,
                    company: u.businessName,
                    specialty: u.providerCategory || "General Service",
                    price: 500,
                    priceUnit: "service",
                    age: 25,
                    gender: "Not specified",
                    address: u.providerLocation || "Batangas City",
                    city: u.providerLocation || "Batangas City",
                    contact: u.phone || "0917-555-0199",
                    email: u.email,
                    photo: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=300&q=80",
                    bio: [
                        u.providerDescription || "Verified local service provider",
                        `Available in ${u.providerLocation || "Batangas"}`
                    ],
                    reviews: []
                }
            ]
        }));

    const map = new Map();
    DEFAULT_PROVIDERS.forEach(p => map.set(p.businessName.toLowerCase(), p));
    registeredProviders.forEach(p => {
        const key = p.businessName.toLowerCase();
        let existing = map.get(key);

        // A default provider that was renamed by its owner: keep it as ONE provider
        if (!existing) {
            const renamedDefault = DEFAULT_PROVIDERS.find(
                d => String(d.email).toLowerCase() === String(p.email || "").toLowerCase()
            );
            if (renamedDefault) {
                existing = renamedDefault;
                map.delete(renamedDefault.businessName.toLowerCase());
            }
        }

        map.set(key, {
            ...existing,
            ...p,
            theme: existing?.theme || p.theme,
            generalReviews: existing?.generalReviews || p.generalReviews,
            specialists: existing?.specialists || p.specialists
        });
    });

    // Specialists edited by the provider replace the built-in ones
    const edited = getSpecialistOverrides();
    const providers = Array.from(map.values()).map(provider => {
        const custom = edited[String(provider.email || "").toLowerCase()];
        return custom && custom.length ? { ...provider, specialists: custom } : provider;
    });

    // Specialists who signed up on their own and picked a category are added to that category
    Object.entries(getJoinedSpecialists()).forEach(([ownerEmail, entry]) => {
        if (!entry || !entry.specialist) return;
        const index = findCategoryHostIndex(providers, entry.category);
        if (index < 0) return;
        providers[index] = {
            ...providers[index],
            specialists: [...(providers[index].specialists || []), { ...entry.specialist, ownerEmail, joined: true }]
        };
    });

    return providers;
}

/* ================= SPECIALISTS WHO JOINED A CATEGORY (Service Provider sign-ups) ================= */
function getJoinedSpecialists() {
    try {
        return JSON.parse(localStorage.getItem(JOINED_SPECIALISTS_KEY)) || {};
    } catch {
        return {};
    }
}

function saveJoinedSpecialists(map) {
    localStorage.setItem(JOINED_SPECIALISTS_KEY, JSON.stringify(map));
}

function getServiceCategories() {
    return [...new Set(DEFAULT_PROVIDERS.map(p => p.providerCategory))];
}

/* Each category has one provider group; new specialists are added to that group */
function findCategoryHostIndex(providers, category) {
    const base = DEFAULT_PROVIDERS.find(d => d.providerCategory === category);
    if (base) {
        const index = providers.findIndex(p => String(p.email || "").toLowerCase() === String(base.email).toLowerCase());
        if (index >= 0) return index;
    }
    return providers.findIndex(p => p.providerCategory === category);
}

/* A Service Provider account without a business is an individual specialist */
function isSpecialistAccount(user) {
    return !!user && user.role === "Service Provider" && !user.businessName;
}

/* ================= PROVIDER-EDITED SPECIALISTS (stored per provider account e-mail) ================= */
function getSpecialistOverrides() {
    try {
        return JSON.parse(localStorage.getItem(SPECIALISTS_KEY)) || {};
    } catch {
        return {};
    }
}

function saveSpecialistOverrides(map) {
    localStorage.setItem(SPECIALISTS_KEY, JSON.stringify(map));
}

function findSpecialistObject(providerName, specialistName) {
    const provider = getAllProvidersData().find(
        p => p.businessName.toLowerCase() === (providerName || "").toLowerCase()
    );
    if (!provider) return null;

    if (specialistName) {
        const pure = extractPureSpecialistName(specialistName).toLowerCase();
        const match = (provider.specialists || []).find(
            s => s.name.toLowerCase() === pure
        );
        if (match) return match;
    }

    return provider.specialists?.[0] || {
        name: provider.ownerName || provider.businessName,
        company: provider.businessName,
        email: provider.email || "24-06547@g.batstate-u.edu.ph",
        contact: "0917-654-7024",
        specialty: provider.providerCategory
    };
}

/* ================= ACCURATE RATING & DATA CALCULATORS ================= */
function getCombinedGeneralReviews(provider) {
    const baseReviews = provider.generalReviews || [];
    const customMap = getCustomGeneralReviews();
    const extraReviews = customMap[provider.businessName.toLowerCase()] || [];
    return [...extraReviews, ...baseReviews];
}

function getCombinedSpecialistReviews(providerName, specialist) {
    const baseReviews = specialist.reviews || [];
    const customMap = getCustomSpecialistReviews();
    const key = makeSpecialistKey(providerName, specialist.name);
    const extraReviews = customMap[key] || [];
    return [...extraReviews, ...baseReviews];
}

function computeStarStats(reviewsList) {
    const count = reviewsList.length;
    if (count === 0) {
        return {
            average: "0.0",
            count: 0,
            starsText: "☆☆☆☆☆",
            display: "No reviews yet"
        };
    }

    const totalStars = reviewsList.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
    const avg = (totalStars / count).toFixed(1);
    const rounded = Math.round(totalStars / count);
    const starsText = "★".repeat(rounded) + "☆".repeat(5 - rounded);
    const label = count === 1 ? "1 review" : `${count} reviews`;

    return {
        average: avg,
        count,
        starsText,
        display: `${avg} (${label})`
    };
}

function calculateProviderPriceRange(provider) {
    const prices = (provider.specialists || [])
        .flatMap(s => [Number(s.price), Number(s.priceMax)])
        .filter(n => !isNaN(n) && n > 0);

    if (prices.length === 0) return "Contact for pricing";

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const formatPeso = num => `₱${num.toLocaleString("en-PH")}`;

    if (min === max) return formatPeso(min);
    return `${formatPeso(min)} – ${formatPeso(max)}`;
}

/* Specialist price: "₱500 – ₱1,500 / service" when a maximum is set, otherwise the single price */
function formatSpecialistPrice(person) {
    const min = Number(person.price);
    const max = Number(person.priceMax);
    if (!min && !max) return "Contact for rate";
    const peso = n => `₱${Number(n).toLocaleString("en-PH")}`;
    const unit = escapeHTML(person.priceUnit || "service");
    if (min && max > min) return `${peso(min)} – ${peso(max)} / ${unit}`;
    return `${peso(min || max)} / ${unit}`;
}

function calculateProviderLocations(provider) {
    const cities = (provider.specialists || [])
        .map(s => s.city || s.address)
        .filter(Boolean);

    const unique = [...new Set(cities)];
    return unique.length ? unique.join(", ") : "Batangas";
}

function syncHomepageProviderCards() {
    const providers = getAllProvidersData();
    document.querySelectorAll(".provider-card").forEach(card => {
        const provider = providers.find(
            p => p.businessName.toLowerCase() === (card.dataset.name || "").toLowerCase()
        );
        if (!provider) return;

        const stats = computeStarStats(getCombinedGeneralReviews(provider));
        const locationText = calculateProviderLocations(provider);
        card.dataset.location = locationText;

        const locSpan = card.querySelector(".card-location-text span");
        if (locSpan) locSpan.textContent = locationText;

        const starsEl = card.querySelector(".card-stars");
        if (starsEl) starsEl.textContent = stats.starsText;

        const ratingEl = card.querySelector(".card-rating-text");
        if (ratingEl) ratingEl.textContent = stats.display;

        renderCardSpecialists(card, provider);
    });
}

/* Little strip on each provider card: every specialist's current photo + first name */
function renderCardSpecialists(card, provider) {
    const specialists = provider.specialists || [];
    let box = card.querySelector(".card-specialists");

    if (!specialists.length) {
        if (box) box.remove();
        return;
    }

    if (!box) {
        box = document.createElement("div");
        box.className = "card-specialists";
        const anchor = card.querySelector(".card-location-text");
        if (anchor) anchor.insertAdjacentElement("afterend", box);
        else card.querySelector(".provider-info")?.appendChild(box);
    }

    const shown = specialists.slice(0, 4);
    const extra = specialists.length - shown.length;
    const firstNames = specialists.map(sp => String(sp.name || "").trim().split(" ")[0]).filter(Boolean);

    box.innerHTML = `
        <div class="card-spec-avatars">
            ${shown.map(sp => `<img src="${escapeAttr(sp.photo || DEFAULT_SPECIALIST_AVATAR)}"
                alt="${escapeAttr(sp.name)}"
                title="${escapeAttr(sp.name + (sp.specialty ? " — " + sp.specialty : ""))}"
                onerror="this.onerror=null;this.src=DEFAULT_SPECIALIST_AVATAR">`).join("")}
            ${extra > 0 ? `<span class="card-spec-more">+${extra}</span>` : ""}
        </div>
        <span class="card-spec-names" title="${escapeAttr(specialists.map(sp => sp.name).join(", "))}">${escapeHTML(firstNames.join(", "))}</span>
    `;
}

/* ================= CLIENT VERIFICATION RULE FOR SPECIALIST RATING ================= */
function canCurrentUserRateSpecialist(providerName, specialistName) {
    const user = getCurrentUser();
    if (!user || user.role !== "Customer") {
        return {
            allowed: false,
            reason: "not_logged_in",
            message: "Mag-login muna gamit ang iyong Customer account. Tanging ang mga naging confirmed client lamang ng specialist na ito ang maaaring mag-rate at mag-upload ng picture proof."
        };
    }

    const bookings = getBookings();
    const targetProvider = providerName.trim().toLowerCase();
    const targetSpec = specialistName.trim().toLowerCase();

    const hasConfirmedBooking = bookings.some(b => {
        const emailMatch = (b.customerEmail || "").toLowerCase() === user.email.toLowerCase();
        const providerMatch = (b.provider || "").trim().toLowerCase() === targetProvider;
        const specText = (b.specialist || "").trim().toLowerCase();
        const specMatch = specText === targetSpec || specText.startsWith(targetSpec);
        const statusConfirmed = b.status === "Confirmed";
        return emailMatch && providerMatch && specMatch && statusConfirmed;
    });

    if (!hasConfirmedBooking) {
        return {
            allowed: false,
            reason: "not_served_client",
            message: `Hindi mo maa-access ang rating kay ${specialistName} dahil hindi ka pa niya naging confirmed client. I-book muna siya at hintayin ang confirmation bago makapag-rate.`
        };
    }

    return { allowed: true, user };
}

/* ================= MODALS & AUTH ================= */
function openLogin() {
    const modal = document.getElementById("loginModal");
    const alreadyOpen = modal.style.display === "flex";
    closeAllModals();
    if (!alreadyOpen) resetLoginFlow();
    modal.style.display = "flex";
}

/* Registration now happens inside the login flow (after the email is verified) */
function openRegister() {
    openLogin();
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = "none";
}

function closeAllModals() {
    document.querySelectorAll(".modal").forEach(m => (m.style.display = "none"));
}

/* ================= AUTH GATE (login required before entering) ================= */
function enterAuthGate() {
    document.querySelectorAll("body > section:not(#userDashboard):not(#providerDashboard)")
        .forEach(sec => (sec.style.display = "none"));
    const footer = document.querySelector("footer");
    if (footer) footer.style.display = "none";
    document.getElementById("userDashboard").style.display = "none";
    document.getElementById("providerDashboard").style.display = "none";

    updateHeroForUser();
    document.body.classList.add("auth-locked");
    const gate = document.getElementById("authGate");
    if (gate) gate.style.display = "flex";

    updateNavAuthButtons();
    openLogin();
    window.scrollTo({ top: 0 });
}

function leaveAuthGate() {
    document.body.classList.remove("auth-locked");
    const gate = document.getElementById("authGate");
    if (gate) gate.style.display = "none";
}

/* ================= LOGIN WITH EMAIL + ONE-TIME CODE (OTP) ================= */
const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;      // code is valid for 5 minutes
const OTP_RESEND_MS = 30 * 1000;       // wait 30 seconds before resending
const OTP_MAX_ATTEMPTS = 5;            // wrong tries before the code is thrown away
const BLOCKED_EMAIL_DOMAINS = [
    "mailinator.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
    "guerrillamail.com", "sharklasers.com", "yopmail.com", "trashmail.com",
    "getnada.com", "dispostable.com", "maildrop.cc", "fakeinbox.com"
];

let loginOtpState = { email: "", code: "", expires: 0, attempts: 0, lastSent: 0, verifiedEmail: "" };
let otpResendInterval = null;

function validateLoginEmail(email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return { ok: false, message: "Please enter a valid email address." };
    }
    const domain = email.split("@")[1];
    if (BLOCKED_EMAIL_DOMAINS.includes(domain)) {
        return { ok: false, message: "Temporary email addresses are not allowed. Please use your real email." };
    }
    return { ok: true };
}

function generateOtpCode() {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    return String(n).padStart(OTP_LENGTH, "0");
}

function isEmailJsConfigured(templateId) {
    const cfg = EMAILJS_CONFIG;
    const placeholder = v => !v || String(v).startsWith("YOUR_");
    return !(placeholder(cfg.serviceId) || placeholder(cfg.publicKey) || placeholder(templateId));
}

async function sendOtpEmail(email, code) {
    if (!isEmailJsConfigured(EMAILJS_CONFIG.otpTemplateId)) {
        return { ok: false, reason: "not_configured" };
    }
    try {
        const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                service_id: EMAILJS_CONFIG.serviceId,
                template_id: EMAILJS_CONFIG.otpTemplateId,
                user_id: EMAILJS_CONFIG.publicKey,
                template_params: {
                    to_email: email,
                    otp_code: code,
                    expires_minutes: OTP_TTL_MS / 60000,
                    app_name: "ProFinder"
                }
            })
        });
        if (response.ok) return { ok: true };

        // EmailJS answers with a short plain-text reason, e.g. "The Public Key is invalid."
        const detail = (await response.text().catch(() => "")).trim().slice(0, 160);
        console.error("EmailJS error", response.status, detail);
        return { ok: false, reason: "send_failed", status: response.status, detail };
    } catch (err) {
        console.error("EmailJS network error", err);
        return { ok: false, reason: "network" };
    }
}

const LOGIN_STEPS = {
    email: {
        form: "loginEmailForm", index: 0, icon: "fa-envelope",
        title: "Welcome Back",
        subtitle: "Enter your email and we'll send you a one-time verification code."
    },
    otp: {
        form: "loginOtpForm", index: 1, icon: "fa-shield-halved",
        title: "Enter Verification Code",
        subtitle: "Type the 6-digit code we sent to your email."
    },
    password: {
        form: "loginPasswordForm", index: 2, icon: "fa-lock",
        title: "Email Verified",
        subtitle: "Enter your password to continue."
    },
    newpass: {
        form: "loginNewPasswordForm", index: 2, icon: "fa-key",
        title: "Create Your Password",
        subtitle: "Email verified! Create a password for your ProFinder account."
    },
    setup: {
        form: "loginSetupForm", index: 2, icon: "fa-user-plus",
        title: "Set Up Your Account",
        subtitle: "Email verified! Tell us a bit about yourself to finish."
    }
};

function goToLoginStep(step) {
    const cfg = LOGIN_STEPS[step];
    if (!cfg) return;

    Object.values(LOGIN_STEPS).forEach(item => {
        const form = document.getElementById(item.form);
        if (form) form.style.display = item.form === cfg.form ? "block" : "none";
    });

    document.getElementById("loginTitle").textContent = cfg.title;
    document.getElementById("loginSubtitle").textContent = cfg.subtitle;
    document.getElementById("loginStepIcon").className = "fa-solid " + cfg.icon;
    document.getElementById("loginProgressLast").textContent = step === "setup" ? "Set up" : "Password";
    document.querySelectorAll("#loginModal .pw-field").forEach(f => (f.type = "password"));
    document.querySelectorAll("#loginModal .show-pass input").forEach(c => (c.checked = false));

    document.querySelectorAll("#loginProgress > span").forEach((el, i) => {
        el.classList.toggle("active", i === cfg.index);
        el.classList.toggle("done", i < cfg.index);
    });

    const focusId = { email: "loginEmail", password: "loginPassword", newpass: "newPassword", setup: "registerName" }[step];
    if (step === "otp") getOtpBoxes()[0]?.focus();
    else if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 50);
}

function resetLoginFlow() {
    clearInterval(otpResendInterval);
    loginOtpState = { email: "", code: "", expires: 0, attempts: 0, lastSent: 0, verifiedEmail: "" };

    ["loginEmailForm", "loginOtpForm", "loginPasswordForm", "loginNewPasswordForm", "loginSetupForm"].forEach(id => {
        document.getElementById(id)?.reset();
    });
    document.getElementById("registerEmail").value = "";
    document.getElementById("registerRole")?.dispatchEvent(new Event("change"));

    const demoBox = document.getElementById("otpDemoBox");
    if (demoBox) demoBox.style.display = "none";

    goToLoginStep("email");
}

async function issueLoginOtp(email, button, idleLabel) {
    const code = generateOtpCode();

    if (button) {
        button.disabled = true;
        button.textContent = "Sending...";
    }
    const result = await sendOtpEmail(email, code);
    if (button) {
        button.disabled = false;
        button.textContent = idleLabel;
    }

    if (!result.ok && result.reason !== "not_configured") {
        let message = "We couldn't send the code. Please check your email address and try again.";
        if (result.reason === "network") message = "No internet connection. Please check your network and try again.";
        else if (result.status === 429) message = "Too many requests. Please wait a moment and try again.";
        else if (result.status === 400 || result.status === 401 || result.status === 403 || result.status === 404) {
            message = "Email service error: " + (result.detail || "check your EmailJS keys and template ID.");
        }
        showToast(message);
        return false;
    }

    loginOtpState = { email, code, expires: Date.now() + OTP_TTL_MS, attempts: 0, lastSent: Date.now(), verifiedEmail: "" };

    const demoBox = document.getElementById("otpDemoBox");
    if (demoBox) {
        const demo = result.reason === "not_configured";
        demoBox.style.display = demo ? "block" : "none";
        document.getElementById("otpDemoCode").textContent = demo ? code : "";
    }
    return true;
}

async function sendLoginOtp(event) {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim().toLowerCase();

    const check = validateLoginEmail(email);
    if (!check.ok) return showToast(check.message);

    const button = document.getElementById("sendOtpBtn");
    const sent = await issueLoginOtp(email, button, "Send Verification Code");
    if (!sent) return;

    document.getElementById("otpEmailLabel").textContent = email;
    clearOtpBoxes();
    goToLoginStep("otp");
    startOtpResendCooldown();
    showToast("Verification code sent! Check your inbox (and spam folder).");
}

async function resendLoginOtp() {
    if (Date.now() < loginOtpState.lastSent + OTP_RESEND_MS) return;
    const sent = await issueLoginOtp(loginOtpState.email, null, "");
    if (!sent) return;
    clearOtpBoxes();
    getOtpBoxes()[0]?.focus();
    startOtpResendCooldown();
    showToast("A new verification code has been sent.");
}

function startOtpResendCooldown() {
    clearInterval(otpResendInterval);
    const button = document.getElementById("resendOtpBtn");
    if (!button) return;

    const tick = () => {
        const left = Math.ceil((loginOtpState.lastSent + OTP_RESEND_MS - Date.now()) / 1000);
        if (left > 0) {
            button.disabled = true;
            button.textContent = `Resend code (${left}s)`;
        } else {
            button.disabled = false;
            button.textContent = "Resend code";
            clearInterval(otpResendInterval);
        }
    };
    tick();
    otpResendInterval = setInterval(tick, 1000);
}

function verifyLoginOtp(event) {
    event.preventDefault();
    const entered = getOtpBoxes().map(b => b.value).join("");

    if (entered.length < OTP_LENGTH) return showToast("Please enter the full 6-digit code.");
    if (!loginOtpState.code) {
        resetLoginFlow();
        return showToast("Please request a new verification code.");
    }
    if (Date.now() > loginOtpState.expires) {
        showToast("This code has expired. We'll send you a new one.");
        return resetLoginFlow();
    }

    if (entered !== loginOtpState.code) {
        loginOtpState.attempts += 1;
        clearOtpBoxes();
        getOtpBoxes()[0]?.focus();
        if (loginOtpState.attempts >= OTP_MAX_ATTEMPTS) {
            showToast("Too many wrong attempts. Please request a new code.");
            return resetLoginFlow();
        }
        return showToast(`Incorrect code. ${OTP_MAX_ATTEMPTS - loginOtpState.attempts} attempt(s) left.`);
    }

    // Code is correct: this email is proven to be real and active
    loginOtpState.verifiedEmail = loginOtpState.email;
    loginOtpState.code = "";
    clearInterval(otpResendInterval);

    // Decide automatically: brand-new email, account without its own password yet, or returning user
    const account = findUserByEmail(loginOtpState.verifiedEmail);
    if (!account) {
        document.getElementById("registerEmail").value = loginOtpState.verifiedEmail;
        goToLoginStep("setup");
    } else if (accountNeedsPasswordSetup(account)) {
        goToLoginStep("newpass");
    } else {
        goToLoginStep("password");
    }
    showToast("Email verified!");
}

function findUserByEmail(email) {
    const target = String(email || "").trim().toLowerCase();
    return getUsers().find(u => String(u.email || "").trim().toLowerCase() === target) || null;
}

/* Demo/seeded provider accounts ship with a default password the real owner doesn't know.
   Until the owner sets their own password (after verifying the email), treat them as "new". */
function accountNeedsPasswordSetup(user) {
    if (user.passwordSet) return false;
    return DEFAULT_PROVIDERS.some(p =>
        String(p.email).toLowerCase() === String(user.email).toLowerCase() && p.password === user.password
    );
}

function togglePasswordVisibility(checkbox) {
    const form = checkbox.closest("form");
    if (!form) return;
    form.querySelectorAll(".pw-field").forEach(f => (f.type = checkbox.checked ? "text" : "password"));
}

/* Forgot password: the email was already proven with the code, so let them pick a new password */
function startPasswordReset() {
    if (!loginOtpState.verifiedEmail) return goToLoginStep("email");
    goToLoginStep("newpass");
    document.getElementById("loginTitle").textContent = "Reset Your Password";
    document.getElementById("loginSubtitle").textContent = "Your email is verified. Choose a new password.";
}

function createPassword(event) {
    event.preventDefault();
    const email = loginOtpState.verifiedEmail;
    if (!email) {
        showToast("Please verify your email first.");
        return goToLoginStep("email");
    }

    const password = document.getElementById("newPassword").value;
    const confirm = document.getElementById("confirmNewPassword").value;
    if (password.length < 6) return showToast("Password must be at least 6 characters.");
    if (password !== confirm) return showToast("Passwords do not match. Please retype them.");

    const users = getUsers();
    const index = users.findIndex(u => String(u.email || "").trim().toLowerCase() === email);
    if (index === -1) {
        document.getElementById("registerEmail").value = email;
        showToast("No account yet for this email. Let's set it up.");
        return goToLoginStep("setup");
    }

    users[index] = { ...users[index], password, passwordSet: true };
    saveUsers(users);
    const user = users[index];

    setCurrentUser(user);
    closeAllModals();
    event.target.reset();
    resetLoginFlow();
    enterApp(user);

    showToast("Password saved. Welcome to ProFinder!");
}

/* ---- 6-box code input helpers ---- */
function getOtpBoxes() {
    return Array.from(document.querySelectorAll("#otpInputs .otp-box"));
}

function clearOtpBoxes() {
    getOtpBoxes().forEach(box => (box.value = ""));
}

function fillOtpBoxes(digits, startIndex = 0) {
    const boxes = getOtpBoxes();
    digits.split("").forEach((d, k) => {
        if (boxes[startIndex + k]) boxes[startIndex + k].value = d;
    });
    const next = boxes[Math.min(startIndex + digits.length, boxes.length - 1)];
    next?.focus();
    if (boxes.every(b => b.value)) document.getElementById("loginOtpForm").requestSubmit();
}

function initOtpInputs() {
    const boxes = getOtpBoxes();
    boxes.forEach((box, i) => {
        box.addEventListener("input", () => {
            const digits = box.value.replace(/\D/g, "");
            box.value = "";
            if (digits) fillOtpBoxes(digits.slice(0, OTP_LENGTH - i), i);
        });
        box.addEventListener("keydown", e => {
            if (e.key === "Backspace" && !box.value && boxes[i - 1]) boxes[i - 1].focus();
            if (e.key === "ArrowLeft" && boxes[i - 1]) boxes[i - 1].focus();
            if (e.key === "ArrowRight" && boxes[i + 1]) boxes[i + 1].focus();
        });
        box.addEventListener("paste", e => {
            e.preventDefault();
            const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, OTP_LENGTH);
            if (digits) fillOtpBoxes(digits, 0);
        });
        box.addEventListener("focus", () => box.select());
    });
}

function register(event) {
    event.preventDefault();
    const name = document.getElementById("registerName").value.trim();
    const email = document.getElementById("registerEmail").value.trim().toLowerCase();
    if (!email || loginOtpState.verifiedEmail !== email) {
        showToast("Please verify your email first.");
        return goToLoginStep("email");
    }
    const role = document.getElementById("registerRole").value;
    const password = document.getElementById("registerPassword").value;
    const confirmPassword = document.getElementById("registerConfirmPassword").value;

    if (password.length < 6) return showToast("Password must be at least 6 characters.");
    if (password !== confirmPassword) return showToast("Passwords do not match. Please retype them.");

    const users = getUsers();
    if (users.some(u => String(u.email || "").trim().toLowerCase() === email)) {
        showToast("This email already has an account. Continue with your password.");
        return goToLoginStep(accountNeedsPasswordSetup(findUserByEmail(email)) ? "newpass" : "password");
    }

    const newUser = {
        name,
        email,
        phone: "0917-555-0199",
        role,
        password,
        passwordSet: true
    };

    users.push(newUser);
    saveUsers(users);
    setCurrentUser(newUser);
    closeAllModals();
    event.target.reset();
    resetLoginFlow();

    enterApp(newUser);
    showToast("Account created successfully!");
}

function login(event) {
    event.preventDefault();
    const email = loginOtpState.verifiedEmail;
    if (!email) {
        showToast("Please verify your email first.");
        return goToLoginStep("email");
    }
    const password = document.getElementById("loginPassword").value;

    const account = findUserByEmail(email);
    if (!account) {
        document.getElementById("registerEmail").value = email;
        showToast("No account yet for this email. Let's set it up.");
        return goToLoginStep("setup");
    }
    if (accountNeedsPasswordSetup(account)) return goToLoginStep("newpass");

    if (account.password !== password) {
        document.getElementById("loginPassword").value = "";
        document.getElementById("loginPassword").focus();
        return showToast("Incorrect password. Try again, or tap “Forgot password?”.");
    }
    const user = account;

    setCurrentUser(user);
    closeAllModals();
    event.target.reset();
    resetLoginFlow();
    enterApp(user);

    showToast("Login successful!");
}

function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    showHomePage();
    updateNavAuthButtons();
    showToast("You have logged out.");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ================= PROVIDER = DASHBOARD ONLY (NEW) =================
   A Service Provider / specialist only receives bookings. They stay on the
   Provider Dashboard and cannot browse providers or send inquiries. */
function isProviderSession() {
    const user = getCurrentUser();
    return !!user && user.role === "Service Provider";
}

function blockProviderBooking() {
    showToast("Service Provider accounts can only receive bookings. Use a Customer account to book a specialist.");
}

/* ================= NAVIGATION & VIEWS ================= */
function updateNavAuthButtons() {
    const user = getCurrentUser();
    const loginBtn = document.querySelector(".login-btn");
    const registerBtn = document.querySelector(".register-btn");
    const dashNavBtn = document.getElementById("navDashboardBtn");
    const backDashBtn = document.querySelector(".back-dashboard-btn");

    if (user) {
        if (loginBtn) loginBtn.style.display = "none";
        if (registerBtn) registerBtn.style.display = "none";
        if (dashNavBtn) dashNavBtn.style.display = "inline-flex";
        if (backDashBtn) backDashBtn.style.display = "inline-block";
    } else {
        if (loginBtn) loginBtn.style.display = "";
        if (registerBtn) registerBtn.style.display = "";
        if (dashNavBtn) dashNavBtn.style.display = "none";
        if (backDashBtn) backDashBtn.style.display = "none";
    }

    /* Providers only see their dashboard, so the public page links are hidden */
    const publicNavLinks = document.getElementById("navLinks");
    const publicMenuBtn = document.querySelector(".menu-btn");
    const providerOnly = isProviderSession();
    if (publicNavLinks) publicNavLinks.style.display = providerOnly ? "none" : "";
    if (publicMenuBtn) publicMenuBtn.style.display = providerOnly ? "none" : "";
}

function hidePublicSections() {
    leaveAuthGate();
    document.querySelectorAll("body > section:not(#userDashboard):not(#providerDashboard)")
        .forEach(sec => (sec.style.display = "none"));
    const footer = document.querySelector("footer");
    if (footer) footer.style.display = "none";
    document.getElementById("userDashboard").style.display = "none";
    document.getElementById("providerDashboard").style.display = "none";
    updateNavAuthButtons();
}

/* Where to go right after logging in: customers land on the Home page, providers on their dashboard */
function enterApp(user) {
    if (user && user.role === "Service Provider") {
        openProviderDashboard();
    } else {
        showHomePage();
        window.scrollTo({ top: 0 });
    }
}

/* Hero: personal greeting + dashboard shortcut for logged-in users */
function updateHeroForUser() {
    const user = getCurrentUser();
    const label = document.getElementById("heroLabelText");
    const icon = document.getElementById("heroLabelIcon");
    const dashBtn = document.getElementById("heroDashboardBtn");
    const dashText = document.getElementById("heroDashboardText");
    if (!label || !icon || !dashBtn) return;

    if (user) {
        const firstName = (user.name || "there").trim().split(" ")[0];
        const shownName = user.role === "Service Provider" ? getProviderDisplayName(user) : firstName;
        label.textContent = `Welcome back, ${shownName}!`;
        icon.className = "fa-solid fa-circle-user";
        dashBtn.style.display = "inline-flex";
        if (dashText) {
            dashText.textContent = user.role === "Service Provider" ? "Go to Provider Dashboard" : "Go to My Dashboard";
        }

        const badge = document.getElementById("heroConfirmedBadge");
        if (badge) {
            const confirmed = user.role === "Customer"
                ? getBookings().filter(b => (b.customerEmail || "").toLowerCase() === user.email.toLowerCase() && b.status === "Confirmed").length
                : 0;
            badge.style.display = confirmed ? "inline-block" : "none";
            badge.textContent = confirmed ? `${confirmed} confirmed` : "";
        }
    } else {
        label.textContent = "Find Local Services Near You";
        icon.className = "fa-solid fa-location-dot";
        dashBtn.style.display = "none";
    }
}

/* Hero: live numbers taken from the page itself */
function updateHeroStats() {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    set("statProviders", document.querySelectorAll(".provider-card").length);
    set("statCategories", document.querySelectorAll(".category-card").length);
    set("statLocations", AVAILABLE_LOCATIONS.length);
}

function showHomePage() {
    if (!getCurrentUser()) {
        enterAuthGate();
        return;
    }
    if (isProviderSession()) {
        const dash = document.getElementById("providerDashboard");
        if (!dash || dash.style.display !== "block") openProviderDashboard();
        return;
    }
    leaveAuthGate();
    document.getElementById("userDashboard").style.display = "none";
    document.getElementById("providerDashboard").style.display = "none";
    document.querySelectorAll("body > section:not(#userDashboard):not(#providerDashboard)")
        .forEach(sec => (sec.style.display = ""));
    const footer = document.querySelector("footer");
    if (footer) footer.style.display = "";
    updateHeroForUser();
    updateHeroStats();
    updateNavAuthButtons();
}

function returnToDashboard() {
    const user = getCurrentUser();
    if (!user) {
        showHomePage();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
    }
    if (user.role === "Service Provider") openProviderDashboard();
    else openUserDashboard();
}

function browseProviders() {
    showHomePage();
    setTimeout(() => document.getElementById("providers").scrollIntoView({ behavior: "smooth" }), 60);
}

function browseCategory(category) {
    const search = document.getElementById("searchInput");
    if (search) search.value = "";
    const location = document.getElementById("locationInput");
    if (location) location.value = "";
    const filter = document.getElementById("categoryFilter");
    if (filter) filter.value = category === "All Categories" ? "all" : category;
    showHomePage();
    applyProviderFilters();
    setTimeout(() => document.getElementById("providers").scrollIntoView({ behavior: "smooth" }), 60);
}

/* ================= STACKED SPECIALIST CARDS & INDIVIDUAL RATINGS ================= */
function renderSpecialistCards(provider) {
    const container = document.getElementById("specialistCardsList");
    if (!container) return;

    const specialists = provider.specialists || [];
    container.innerHTML = specialists.map(person => {
        const bioBullets = (person.bio || [])
            .map(line => `<li>-${escapeHTML(line)}</li>`)
            .join("");

        const formattedPrice = formatSpecialistPrice(person);

        const specReviews = getCombinedSpecialistReviews(provider.businessName, person);
        const specStats = computeStarStats(specReviews);
        const ratingBadgeText = specStats.count === 0
            ? "☆☆☆☆☆ No ratings yet"
            : `${specStats.starsText} ${specStats.average} (${specStats.count} verified ${specStats.count === 1 ? "review" : "reviews"})`;

        const eligibility = canCurrentUserRateSpecialist(provider.businessName, person.name);
        const rateBtnLabel = eligibility.allowed
            ? `<i class="fa-solid fa-star"></i> Rate & Upload Proof`
            : `<i class="fa-solid fa-lock"></i> Rate (Clients Only)`;
        const rateBtnClass = eligibility.allowed
            ? "rate-spec-action-btn unlocked"
            : "rate-spec-action-btn locked";

        return `
            <article class="specialist-person-card">
                <img src="${escapeHTML(person.photo)}"
                     alt="${escapeHTML(person.name)}"
                     class="specialist-photo"
                     onerror="this.src='https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=300&q=80'">

                <div class="specialist-info-fields">
                    <div class="spec-name-rating-row">
                        <div class="spec-field">
                            <span class="spec-label">Name:</span>
                            <span class="spec-value strong">${escapeHTML(person.name)}</span>
                        </div>
                        <button type="button"
                                class="specialist-rating-badge"
                                title="Click to view verified client ratings & picture proofs"
                                onclick="openSpecialistReviewsModal('${escapeAttr(provider.businessName)}', '${escapeAttr(person.name)}', false)">
                            ${ratingBadgeText}
                        </button>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Company (Independent):</span>
                        <span class="spec-value company-tag"><i class="fa-solid fa-building"></i> ${escapeHTML(person.company || provider.businessName)}</span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Specialty & Price:</span>
                        <span class="spec-value specialty-price-tag">${escapeHTML(person.specialty || provider.providerCategory)} — <strong>${formattedPrice}</strong></span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Age:</span>
                        <span class="spec-value">${escapeHTML(person.age)}</span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Gender:</span>
                        <span class="spec-value">${escapeHTML(person.gender)}</span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Address:</span>
                        <span class="spec-value">${escapeHTML(person.address)}</span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Email & SMS Contact:</span>
                        <span class="spec-value spec-email-line">
                            <i class="fa-solid fa-envelope"></i> ${escapeHTML(person.email || provider.email)} &nbsp;|&nbsp;
                            <i class="fa-solid fa-phone"></i> ${escapeHTML(person.contact)}
                        </span>
                    </div>

                    <div class="spec-field">
                        <span class="spec-label">Bio</span>
                        <ul class="spec-bio-list">${bioBullets}</ul>
                    </div>

                    <div class="specialist-card-actions">
                        <button type="button"
                                class="choose-specialist-btn"
                                onclick="selectSpecialistAndBook('${escapeAttr(provider.businessName)}', '${escapeAttr(person.name)}', '${escapeAttr(person.company || "")}')">
                            <i class="fa-solid fa-calendar-check"></i> Choose & Book ${escapeHTML(person.name.split(" ")[0])}
                        </button>

                        <button type="button"
                                class="view-spec-reviews-btn"
                                onclick="openSpecialistReviewsModal('${escapeAttr(provider.businessName)}', '${escapeAttr(person.name)}', false)">
                            <i class="fa-solid fa-camera"></i> Reviews & Proof (${specStats.count})
                        </button>

                        <button type="button"
                                class="${rateBtnClass}"
                                onclick="openSpecialistReviewsModal('${escapeAttr(provider.businessName)}', '${escapeAttr(person.name)}', true)">
                            ${rateBtnLabel}
                        </button>
                    </div>
                </div>
            </article>
        `;
    }).join("");
}

/* ================= INDIVIDUAL SPECIALIST REVIEW & PICTURE PROOF MODAL ================= */
function openSpecialistReviewsModal(providerName, specialistName, focusRatingSection = false) {
    const provider = getAllProvidersData().find(
        p => p.businessName.toLowerCase() === providerName.toLowerCase()
    );
    if (!provider) return;

    const specialist = (provider.specialists || []).find(
        s => s.name.toLowerCase() === specialistName.toLowerCase()
    );
    if (!specialist) return;

    activeReviewProviderName = provider.businessName;
    activeReviewSpecialistName = specialist.name;
    pendingProofDataUrl = "";

    const reviews = getCombinedSpecialistReviews(provider.businessName, specialist);
    const stats = computeStarStats(reviews);

    document.getElementById("specModalPhoto").src = specialist.photo;
    document.getElementById("specModalCompany").textContent = specialist.company || provider.businessName;
    document.getElementById("specModalName").textContent = specialist.name;
    document.getElementById("specModalSpecialty").textContent = specialist.specialty || provider.providerCategory;
    document.getElementById("specModalRatingSummary").textContent = stats.count === 0
        ? "☆☆☆☆☆ No verified client ratings yet"
        : `${stats.starsText} ${stats.average} (${stats.count} Verified Client ${stats.count === 1 ? "Review" : "Reviews"})`;

    const listEl = document.getElementById("specModalReviewsList");
    listEl.innerHTML = reviews.length
        ? reviews.map(rev => {
            const stars = "★".repeat(rev.rating) + "☆".repeat(5 - rev.rating);
            const caption = rev.proofCaption || "Served Properly — Verified Service Proof";
            return `
                <article class="spec-proof-card">
                    <div class="spec-proof-card-top">
                        <div>
                            <strong><i class="fa-solid fa-circle-check verified-client-icon"></i> ${escapeHTML(rev.client)}</strong>
                            <span class="verified-tag">Served Client</span>
                        </div>
                        <span class="review-stars">${stars}</span>
                    </div>
                    <p class="spec-proof-comment">"${escapeHTML(rev.comment)}"</p>
                    ${rev.proofPhoto ? `
                        <div class="proof-photo-container" onclick="openProofLightbox('${escapeAttr(rev.proofPhoto)}', '${escapeAttr(caption)} — Client: ${escapeAttr(rev.client)}')">
                            <img src="${escapeHTML(rev.proofPhoto)}"
                                 alt="${escapeHTML(caption)}"
                                 onerror="this.src='https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=500&q=80'">
                            <span class="proof-zoom-badge"><i class="fa-solid fa-magnifying-glass-plus"></i> ${escapeHTML(caption)}</span>
                        </div>
                    ` : ""}
                    <small class="review-date">${escapeHTML(rev.date)}</small>
                </article>
            `;
        }).join("")
        : '<p class="empty-review-text"><i class="fa-regular fa-star"></i> No reviews yet — served customers can be the first to rate and post picture proof!</p>';

    const eligibility = canCurrentUserRateSpecialist(provider.businessName, specialist.name);
    const lockedBox = document.getElementById("specRatingLockedBox");
    const ratingForm = document.getElementById("specRatingForm");
    const previewWrap = document.getElementById("specProofPreviewWrap");
    if (previewWrap) previewWrap.style.display = "none";

    if (eligibility.allowed) {
        lockedBox.style.display = "none";
        ratingForm.style.display = "block";
        ratingForm.reset();
        document.getElementById("specReviewerName").value = eligibility.user.name || "Verified Client";
    } else {
        ratingForm.style.display = "none";
        lockedBox.style.display = "flex";
        document.getElementById("specRatingLockedMsg").textContent = eligibility.message;

        const lockBtn = document.getElementById("specBookNowFromLockBtn");
        if (eligibility.reason === "not_logged_in") {
            lockBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login as Customer to Check Eligibility';
            lockBtn.onclick = () => {
                closeModal("specialistReviewModal");
                closeModal("profileModal");
                openLogin();
            };
        } else {
            lockBtn.innerHTML = `<i class="fa-solid fa-calendar-check"></i> Book ${escapeHTML(specialist.name.split(" ")[0])} Now`;
            lockBtn.onclick = () => {
                closeModal("specialistReviewModal");
                selectSpecialistAndBook(provider.businessName, specialist.name, specialist.company || "");
            };
        }
    }

    // Provider previewing the website: read-only, nothing to log in for or book
    const previewLockBtn = document.getElementById("specBookNowFromLockBtn");
    if (isProviderSession()) {
        document.getElementById("specRatingLockedMsg").textContent =
            "Preview mode: you're viewing this page as a visitor. Only customers who were served by this specialist can rate.";
        if (previewLockBtn) previewLockBtn.style.display = "none";
    } else if (previewLockBtn) {
        previewLockBtn.style.display = "";
    }

    const modalEl = document.getElementById("specialistReviewModal");
    modalEl.style.display = "flex";

    if (focusRatingSection) {
        const targetEl = eligibility.allowed ? ratingForm : lockedBox;
        setTimeout(() => targetEl?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
    }
}

function previewProofImage(event) {
    const file = event.target.files?.[0];
    const previewWrap = document.getElementById("specProofPreviewWrap");
    const previewImg = document.getElementById("specProofPreviewImg");
    if (!file) {
        pendingProofDataUrl = "";
        if (previewWrap) previewWrap.style.display = "none";
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const maxWidth = 520;
            const scale = img.width > maxWidth ? maxWidth / img.width : 1;
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            pendingProofDataUrl = canvas.toDataURL("image/jpeg", 0.78);
            if (previewImg) previewImg.src = pendingProofDataUrl;
            if (previewWrap) previewWrap.style.display = "flex";
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function submitSpecialistReview(event) {
    event.preventDefault();
    if (isProviderSession()) return blockPreviewAction();
    if (!activeReviewProviderName || !activeReviewSpecialistName) return;

    const eligibility = canCurrentUserRateSpecialist(activeReviewProviderName, activeReviewSpecialistName);
    if (!eligibility.allowed) {
        showToast("Only confirmed clients of this specialist can submit a rating.");
        return;
    }

    const rating = parseInt(document.getElementById("specReviewerRating").value, 10) || 5;
    const comment = document.getElementById("specReviewerComment").value.trim();

    if (!comment) return;
    if (!pendingProofDataUrl) {
        return showToast("Please upload a picture proof of the completed service.");
    }

    const customMap = getCustomSpecialistReviews();
    const key = makeSpecialistKey(activeReviewProviderName, activeReviewSpecialistName);
    if (!customMap[key]) customMap[key] = [];

    customMap[key].unshift({
        client: eligibility.user.name || "Verified Client",
        rating,
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        comment,
        proofPhoto: pendingProofDataUrl,
        proofCaption: "Served Properly — Verified Client Service Proof"
    });

    saveCustomSpecialistReviews(customMap);
    pendingProofDataUrl = "";

    openSpecialistReviewsModal(activeReviewProviderName, activeReviewSpecialistName, false);
    if (currentProvider) {
        const provider = getAllProvidersData().find(
            p => p.businessName.toLowerCase() === currentProvider.toLowerCase()
        );
        if (provider) renderSpecialistCards(provider);
    }

    showToast("Thank you! Your specialist rating & picture proof have been posted.");
}

function openProofLightbox(imgSrc, captionText) {
    const imgEl = document.getElementById("lightboxProofImg");
    const capEl = document.getElementById("lightboxProofCaption");
    if (imgEl) imgEl.src = imgSrc;
    if (capEl) capEl.textContent = captionText || "Service Proof";
    document.getElementById("proofLightboxModal").style.display = "flex";
}

/* ================= GENERAL CATEGORY REVIEWS (BOTTOM SECTION) ================= */
function renderProviderReviews(provider) {
    const listEl = document.getElementById("providerReviewsList");
    const countBadge = document.getElementById("reviewCountBadge");
    if (!listEl) return;

    const reviews = getCombinedGeneralReviews(provider);
    const stats = computeStarStats(reviews);

    if (countBadge) {
        countBadge.textContent = stats.count === 0
            ? "0 reviews"
            : `${stats.average} ★ (${stats.count} ${stats.count === 1 ? "review" : "reviews"})`;
    }

    listEl.innerHTML = reviews.length
        ? reviews.map(rev => {
            const stars = "★".repeat(rev.rating) + "☆".repeat(5 - rev.rating);
            const anonymous = rev.anonymous === true || String(rev.client || "").trim().toLowerCase() === "anonymous";
            return `
                <div class="client-review-item">
                    <div class="review-item-top">
                        <strong class="${anonymous ? "review-anon" : ""}"><i class="fa-solid ${anonymous ? "fa-user-secret" : "fa-circle-user"}"></i> ${anonymous ? "Anonymous" : escapeHTML(rev.client)}</strong>
                        <span class="review-stars">${stars}</span>
                    </div>
                    <p class="review-comment">"${escapeHTML(rev.comment)}"</p>
                    <small class="review-date">${escapeHTML(rev.date)}</small>
                </div>
            `;
        }).join("")
        : '<p class="empty-review-text"><i class="fa-regular fa-star"></i> No reviews yet. Customers can leave the first review below!</p>';

    // A different provider was opened: start the form fresh (anonymous switch back to its default)
    const formKey = String(provider.businessName).toLowerCase();
    if (lastReviewFormProvider !== formKey) {
        lastReviewFormProvider = formKey;
        resetReviewAnonymous();
    }

    const user = getCurrentUser();
    const nameInput = document.getElementById("reviewerName");
    if (nameInput && user && !nameInput.value && !nameInput.disabled && !isProviderSession()) {
        nameInput.value = user.name || "";
    }
}

/* ---- General review: "Post anonymously" switch ---- */
let lastReviewFormProvider = "";

function toggleReviewAnonymous(input) {
    const nameInput = document.getElementById("reviewerName");
    const note = document.getElementById("reviewAnonNote");
    if (!nameInput) return;

    if (input.checked) {
        nameInput.dataset.realName = nameInput.value;   // remember it so we can put it back
        nameInput.value = "";
        nameInput.placeholder = "Anonymous";
        nameInput.disabled = true;
        nameInput.required = false;
    } else {
        nameInput.disabled = false;
        nameInput.required = true;
        nameInput.placeholder = "Your Name";
        nameInput.value = nameInput.dataset.realName || (isProviderSession() ? "" : (getCurrentUser()?.name || ""));
        delete nameInput.dataset.realName;
    }
    if (note) note.style.display = input.checked ? "block" : "none";
}

function resetReviewAnonymous() {
    const input = document.getElementById("reviewAnonymous");
    if (input && input.checked) {
        input.checked = false;
        toggleReviewAnonymous(input);
    }
}

/* ---- Provider "See it on the website": everything is read-only ---- */
function applyPreviewMode() {
    const preview = isProviderSession();

    const banner = document.getElementById("previewModeBanner");
    if (banner) banner.style.display = preview ? "flex" : "none";

    const form = document.querySelector("#profileModal .add-review-form");
    if (!form) return;
    form.classList.toggle("preview-locked", preview);
    form.querySelectorAll("input, select, textarea, button").forEach(el => {
        el.disabled = preview;
    });

    if (preview) {
        const nameInput = document.getElementById("reviewerName");
        if (nameInput) nameInput.value = "";
    } else if (document.getElementById("reviewAnonymous")?.checked) {
        document.getElementById("reviewerName").disabled = true;   // anonymous keeps the name locked
    }
}

function blockPreviewAction() {
    showToast("You're in preview mode. Only customers can post reviews.");
}

function submitProviderReview(event) {
    event.preventDefault();
    if (isProviderSession()) return blockPreviewAction();
    if (!currentProvider) return;

    const anonymous = !!document.getElementById("reviewAnonymous")?.checked;
    // Anonymous: the real name is never saved with the review
    const clientName = anonymous ? "Anonymous" : document.getElementById("reviewerName").value.trim();
    const rating = parseInt(document.getElementById("reviewerRating").value, 10) || 5;
    const comment = document.getElementById("reviewerComment").value.trim();

    if (!clientName || !comment) return;

    const customMap = getCustomGeneralReviews();
    const key = currentProvider.toLowerCase();
    if (!customMap[key]) customMap[key] = [];

    customMap[key].unshift({
        client: clientName,
        anonymous,
        rating,
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        comment
    });

    saveCustomGeneralReviews(customMap);
    document.getElementById("reviewerComment").value = "";
    resetReviewAnonymous();

    viewProvider(currentProvider);
    syncHomepageProviderCards();
    showToast("Thank you! Your review has been added.");
}

function viewProvider(name) {
    const provider = getAllProvidersData().find(
        p => p.businessName.toLowerCase() === name.toLowerCase()
    );
    if (!provider) return;

    currentProvider = provider.businessName;

    const box = document.getElementById("providerDirectoryBox");
    if (box) {
        box.className = `modal-content provider-directory-modal ${provider.theme || "theme-blue"}`;
    }

    const generalStats = computeStarStats(getCombinedGeneralReviews(provider));
    const priceRange = calculateProviderPriceRange(provider);
    const locations = calculateProviderLocations(provider);

    document.getElementById("profileCategoryBadge").textContent = provider.providerCategory;
    document.getElementById("profileName").textContent = provider.businessName;
    document.getElementById("profileService").textContent = provider.serviceTitle || provider.providerDescription;

    document.getElementById("profileLocation").textContent = locations;
    document.getElementById("profileRating").textContent = generalStats.display;
    document.getElementById("profileRate").textContent = priceRange;

    applyPreviewMode();   // first: unlock/lock the form, so the name can be filled in below
    renderSpecialistCards(provider);
    renderProviderReviews(provider);
    document.getElementById("profileModal").style.display = "flex";
}

function selectSpecialistAndBook(providerName, specialistName, companyName = "") {
    if (isProviderSession()) {
        blockProviderBooking();
        return;
    }
    closeModal("profileModal");
    const label = companyName ? `${specialistName} (${companyName})` : specialistName;
    openInquiry(providerName, label);
}

function getCategoryIconClass(category) {
    const map = {
        "Computer": { bg: "computer", icon: "fa-laptop" },
        "Cleaning": { bg: "cleaning", icon: "fa-broom" },
        "Beauty": { bg: "beauty", icon: "fa-scissors" },
        "Tutoring": { bg: "tutoring", icon: "fa-book-open" },
        "Home Repair": { bg: "repair", icon: "fa-screwdriver-wrench" },
        "Transportation": { bg: "transport", icon: "fa-car" },
        "Appliance Repair": { bg: "appliance", icon: "fa-snowflake" },
        "Pet Care": { bg: "petcare", icon: "fa-paw" },
        "Events & Photography": { bg: "photography", icon: "fa-camera-retro" },
        "Auto Repair": { bg: "autorepair", icon: "fa-wrench" }
    };
    return map[category] || { bg: "computer", icon: "fa-briefcase" };
}

function publishProviderCard(provider) {
    if (!provider?.businessName || !provider.providerCategory) return;
    const grid = document.getElementById("providerGrid");
    if (!grid) return;

    const existing = [...grid.querySelectorAll(".provider-card")].find(
        card => card.dataset.name.toLowerCase() === provider.businessName.toLowerCase()
    );

    if (existing) {
        existing.dataset.category = provider.providerCategory;
        existing.dataset.location = provider.providerLocation || "";
        const serviceEl = existing.querySelector(".service");
        if (serviceEl) serviceEl.textContent = provider.providerDescription || provider.providerCategory;
        syncHomepageProviderCards();
        applyProviderFilters();
        return;
    }

    const visual = getCategoryIconClass(provider.providerCategory);
    const card = document.createElement("div");
    card.className = "provider-card";
    card.dataset.category = provider.providerCategory;
    card.dataset.name = provider.businessName;
    card.dataset.location = provider.providerLocation || "";

    card.innerHTML = `
        <div class="provider-image ${visual.bg}">
            <i class="fa-solid ${visual.icon}"></i>
            <button class="favorite" onclick="toggleFavorite(this)">
                <i class="fa-regular fa-heart"></i>
            </button>
        </div>
        <div class="provider-info">
            <span class="verified"><i class="fa-solid fa-circle-check"></i> Verified Specialists</span>
            <h3>${escapeHTML(provider.businessName)}</h3>
            <p class="service">${escapeHTML(provider.providerDescription || provider.providerCategory)}</p>
            <p class="card-location-text"><i class="fa-solid fa-location-dot"></i> <span>${escapeHTML(provider.providerLocation || "Batangas")}</span></p>
            <div class="rating"><span class="card-stars">☆☆☆☆☆</span> <span class="card-rating-text">No reviews yet</span></div>
            <div class="provider-actions">
                <button onclick="viewProvider('${escapeAttr(provider.businessName)}')">View Providers</button>
                <button class="outline" onclick="openInquiry('${escapeAttr(provider.businessName)}')">Contact</button>
            </div>
        </div>
    `;
    grid.appendChild(card);
    syncHomepageProviderCards();
    applyProviderFilters();
}

/* ================= BOOKING CHANNEL SELECTION (EMAIL vs SMS) ================= */
function selectBookingChannel(channel) {
    selectedBookingChannel = channel === "sms" ? "sms" : "email";
    const emailBtn = document.getElementById("channelEmailBtn");
    const smsBtn = document.getElementById("channelSmsBtn");
    const phoneInput = document.getElementById("inquiryPhone");
    const hintEl = document.getElementById("channelRoutingHint");
    const submitBtn = document.getElementById("sendBookingSubmitBtn");

    const targetEmail = currentSpecialistObj?.email || "24-06547@g.batstate-u.edu.ph";
    const targetPhone = currentSpecialistObj?.contact || "0917-654-7024";

    if (selectedBookingChannel === "email") {
        emailBtn?.classList.add("active");
        smsBtn?.classList.remove("active");
        if (phoneInput) {
            phoneInput.style.display = "none";
            phoneInput.required = false;
        }
        if (hintEl) {
            hintEl.innerHTML = `<i class="fa-solid fa-envelope-circle-check"></i> Routing via <strong>Email</strong> to: <strong>${escapeHTML(targetEmail)}</strong>`;
        }
        if (submitBtn) {
            submitBtn.innerHTML = `<i class="fa-solid fa-envelope"></i> Send Booking Thru Email`;
        }
    } else {
        smsBtn?.classList.add("active");
        emailBtn?.classList.remove("active");
        if (phoneInput) {
            phoneInput.style.display = "block";
            phoneInput.required = true;
        }
        if (hintEl) {
            hintEl.innerHTML = `<i class="fa-solid fa-comment-sms"></i> Routing via <strong>SMS</strong> to: <strong>${escapeHTML(targetPhone)}</strong>`;
        }
        if (submitBtn) {
            submitBtn.innerHTML = `<i class="fa-solid fa-comment-sms"></i> Send Booking Thru SMS`;
        }
    }
}

function openInquiry(name, specialistName = "") {
    if (isProviderSession()) {
        blockProviderBooking();
        return;
    }
    currentProvider = name;
    currentSpecialist = specialistName;
    currentSpecialistObj = findSpecialistObject(name, specialistName);

    const user = getCurrentUser();
    document.getElementById("selectedProvider").textContent = name;

    const badge = document.getElementById("selectedSpecialistBadge");
    if (badge) {
        if (specialistName) {
            badge.style.display = "inline-block";
            badge.textContent = `Selected Specialist: ${specialistName}`;
        } else if (currentSpecialistObj) {
            badge.style.display = "inline-block";
            badge.textContent = `Assigned Specialist: ${currentSpecialistObj.name} (${currentSpecialistObj.company})`;
        } else {
            badge.style.display = "none";
            badge.textContent = "";
        }
    }

    const contactPill = document.getElementById("selectedSpecialistContact");
    if (contactPill && currentSpecialistObj) {
        contactPill.style.display = "inline-block";
        contactPill.innerHTML = `<i class="fa-solid fa-envelope"></i> ${escapeHTML(currentSpecialistObj.email || "24-06547@g.batstate-u.edu.ph")} &nbsp;•&nbsp; <i class="fa-solid fa-phone"></i> ${escapeHTML(currentSpecialistObj.contact || "0917-654-7024")}`;
    }

    if (user) {
        document.getElementById("inquiryName").value = user.name || "";
        document.getElementById("inquiryEmail").value = user.email || "";
    }

    selectBookingChannel("email");
    closeModal("profileModal");
    document.getElementById("inquiryModal").style.display = "flex";
}

/* ================= BRANDED SPECIALIST EMAIL TEMPLATE & SIMULATION ================= */
function buildSpecialistEmailHTML(booking, specialist) {
    const specUpper = (specialist?.name || "SPECIALIST").toUpperCase();
    const clientName = escapeHTML(booking.customerName);
    const clientEmail = escapeHTML(booking.customerEmail);
    const problemTitle = escapeHTML(booking.problem || "General Service Request");
    const description = escapeHTML(booking.message);
    const scheduleFormatted = escapeHTML(formatSchedule(booking.schedule));
    const replyMailto = `mailto:${encodeURIComponent(booking.customerEmail)}?subject=${encodeURIComponent(`Re: ProFinder Booking - ${booking.problem}`)}`;

    return `
        <div style="background:#f3f4f6; padding:20px 14px 28px; font-family:Arial, Helvetica, sans-serif; color:#1e293b;">
            <div style="background:linear-gradient(115deg, #06283d 0%, #0a4d4e 55%, #0f6b5c 100%); border-radius:10px 10px 0 0; padding:26px 32px 76px; display:flex; justify-content:space-between; align-items:center; color:#ffffff;">
                <span style="font-size:17px; font-weight:600; letter-spacing:0.3px;">Specialist Booking</span>
                <span style="font-size:21px; font-weight:800; letter-spacing:-0.4px;">pro<span style="color:#4ade80;">finder</span></span>
            </div>

            <div style="max-width:540px; margin:-52px auto 18px; background:#ffffff; border-radius:14px; padding:32px 30px; box-shadow:0 6px 20px rgba(15,23,42,0.08); border:1px solid #e5e7eb;">
                <p style="font-size:15px; font-weight:700; color:#0f172a; margin:0 0 16px;">
                    Hi ${escapeHTML(specUpper)},
                </p>

                <p style="font-size:14px; line-height:1.65; color:#334155; margin:0 0 16px;">
                    <strong>${clientName}</strong> has just submitted a new service booking request for you on ProFinder. Review the client's concern and service details below so you can respond promptly:
                </p>

                <div style="background:#f8fafc; border:1px solid #cbd5e1; border-left:4px solid #0f6b5c; border-radius:10px; padding:14px 16px; margin:0 0 18px; font-size:13.5px; line-height:1.6;">
                    <div style="margin-bottom:6px;"><strong>Client Name:</strong> ${clientName}</div>
                    <div style="margin-bottom:6px;"><strong>Client Email:</strong> <a href="mailto:${clientEmail}" style="color:#1d4ed8;">${clientEmail}</a></div>
                    <div style="margin-bottom:6px;"><strong>Preferred Schedule:</strong> ${scheduleFormatted}</div>
                    <div style="margin-bottom:6px;"><strong>Problem / Concern:</strong> <span style="color:#0f172a; font-weight:700;">${problemTitle}</span></div>
                    <div><strong>Description:</strong> ${description}</div>
                </div>

                <p style="margin:0 0 16px; font-size:14px;">
                    👉 <a href="javascript:void(0)" onclick="confirmBookingFromEmail(${booking.id})" style="color:#1d4ed8; font-weight:700; text-decoration:underline;">Confirm & Accept Booking Request</a>
                </p>

                <p style="font-size:14px; line-height:1.65; color:#334155; margin:0 0 16px;">
                    Need to ask follow-up questions before your visit? You can reply directly to <strong>${clientName}</strong> or manage this schedule inside your ProFinder Specialist Workspace.
                </p>

                <p style="margin:0 0 20px; font-size:14px;">
                    👉 <a href="${replyMailto}" target="_blank" style="color:#1d4ed8; font-weight:700; text-decoration:underline;">Reply Directly to ${clientName}</a>
                </p>

                <p style="font-size:14px; line-height:1.6; color:#334155; margin:0;">
                    Cheers,<br>
                    <strong>ProFinder Specialist Team</strong>
                </p>
            </div>

            <div style="text-align:center; font-size:12px; color:#6b7280; margin-top:12px;">
                ©2026 ProFinder, Inc. All rights reserved.
            </div>
        </div>
    `;
}

async function sendEmailToSpecialistAPI(booking, specialist, htmlBody) {
    if (!isEmailJsConfigured(EMAILJS_CONFIG.templateId)) {
        return { ok: false, reason: "not_configured" };
    }

    const payload = {
        service_id: EMAILJS_CONFIG.serviceId,
        template_id: EMAILJS_CONFIG.templateId,
        user_id: EMAILJS_CONFIG.publicKey,
        template_params: {
            to_email: specialist.email,
            specialist_name: specialist.name,
            client_name: booking.customerName,
            client_email: booking.customerEmail,
            problem_title: booking.problem,
            service_description: booking.message,
            booking_schedule: formatSchedule(booking.schedule),
            html_message: htmlBody
        }
    };

    const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    return { ok: response.ok };
}

function openSpecialistEmailSimulation(booking, specialist) {
    const targetEmail = specialist?.email || "24-06547@g.batstate-u.edu.ph";
    const subject = `New Booking Request: ${booking.problem} — from ${booking.customerName}`;
    const htmlBody = buildSpecialistEmailHTML(booking, specialist);

    document.getElementById("gmailSubjectText").textContent = subject;
    document.getElementById("gmailRecipientEmail").textContent = targetEmail;
    document.getElementById("gmailTimestampText").textContent = new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
    });
    document.getElementById("gmailRenderedBody").innerHTML = htmlBody;

    const plainTextBody = [
        `Hi ${(specialist?.name || "SPECIALIST").toUpperCase()},`,
        ``,
        `You have received a new service booking request on ProFinder:`,
        ``,
        `Client Name: ${booking.customerName}`,
        `Client Email: ${booking.customerEmail}`,
        `Preferred Schedule: ${formatSchedule(booking.schedule)}`,
        `Problem / Concern: ${booking.problem}`,
        `Description: ${booking.message}`,
        ``,
        `Cheers,`,
        `ProFinder Specialist Team`
    ].join("\n");

    const mailtoHref = `mailto:${encodeURIComponent(targetEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plainTextBody)}`;
    const realGmailBtn = document.getElementById("openRealGmailLink");
    if (realGmailBtn) realGmailBtn.href = mailtoHref;

    const confirmBtn = document.getElementById("gmailConfirmBookingBtn");
    if (confirmBtn) {
        confirmBtn.onclick = () => confirmBookingFromEmail(booking.id);
    }

    document.getElementById("emailPreviewModal").style.display = "flex";
}

function confirmBookingFromEmail(bookingId) {
    const bookings = getBookings();
    const target = bookings.find(b => b.id === bookingId);
    if (!target) return;

    target.status = "Confirmed";
    saveBookings(bookings);

    const user = getCurrentUser();
    if (user?.role === "Customer") renderCustomerBookings();
    if (user?.role === "Service Provider") renderProviderRequests();

    closeModal("emailPreviewModal");
    showToast(`Booking confirmed by ${extractPureSpecialistName(target.specialist)}! Rating & Proof unlocked.`);
}

function openSpecialistSmsSimulation(booking, specialist) {
    const targetName = specialist?.name || "Specialist";
    const targetPhone = specialist?.contact || "0917-654-7024";

    const smsText = [
        `[ProFinder Booking Alert]`,
        `Hi ${targetName}, new booking from ${booking.customerName}!`,
        `Client Phone: ${booking.customerPhone || "N/A"}`,
        `Problem: ${booking.problem}`,
        `Schedule: ${formatSchedule(booking.schedule)}`,
        `Details: ${booking.message}`
    ].join("\n");

    document.getElementById("smsRecipientName").textContent = targetName;
    document.getElementById("smsRecipientNumber").textContent = targetPhone;
    document.getElementById("smsBubbleText").textContent = smsText;

    const cleanPhone = targetPhone.replace(/[^+\d]/g, "");
    const smsHref = `sms:${cleanPhone}?body=${encodeURIComponent(smsText)}`;
    const deviceBtn = document.getElementById("openDeviceSmsLink");
    if (deviceBtn) deviceBtn.href = smsHref;

    document.getElementById("smsPreviewModal").style.display = "flex";
}

async function sendInquiry(event) {
    event.preventDefault();
    const user = getCurrentUser();
    const specialistObj = currentSpecialistObj || findSpecialistObject(currentProvider, currentSpecialist);

    const clientName = document.getElementById("inquiryName").value.trim();
    const clientEmail = document.getElementById("inquiryEmail").value.trim().toLowerCase();
    const clientPhone = document.getElementById("inquiryPhone")?.value.trim() || "";
    const problemTitle = document.getElementById("inquiryProblem").value.trim();
    const scheduleVal = document.getElementById("inquirySchedule")?.value || "Flexible";
    const descriptionVal = document.getElementById("inquiryMessage").value.trim();

    const assignedSpecialistLabel = currentSpecialist
        || (specialistObj ? `${specialistObj.name} (${specialistObj.company})` : "Any Available Specialist");

    const request = {
        id: Date.now(),
        provider: currentProvider,
        specialist: assignedSpecialistLabel,
        specialistEmail: specialistObj?.email || "24-06547@g.batstate-u.edu.ph",
        specialistPhone: specialistObj?.contact || "0917-654-7024",
        channel: selectedBookingChannel,
        customerName: clientName,
        customerEmail: clientEmail || user?.email || "client@profinder.com",
        customerPhone: clientPhone,
        problem: problemTitle,
        schedule: scheduleVal,
        message: descriptionVal,
        status: "Pending",
        date: new Date().toISOString()
    };

    const bookings = getBookings();
    bookings.push(request);
    saveBookings(bookings);

    event.target.reset();
    closeModal("inquiryModal");
    if (user?.role === "Customer") renderCustomerBookings();

    if (selectedBookingChannel === "email") {
        const htmlBody = buildSpecialistEmailHTML(request, specialistObj);
        try {
            await sendEmailToSpecialistAPI(request, specialistObj, htmlBody);
        } catch (err) {
            console.warn("EmailJS API fallback to interactive Gmail simulation:", err);
        }
        openSpecialistEmailSimulation(request, specialistObj);
        showToast(`Booking sent thru Email to ${request.specialistEmail}!`);
    } else {
        openSpecialistSmsSimulation(request, specialistObj);
        showToast(`Booking sent thru SMS to ${request.specialistPhone}!`);
    }

    currentSpecialist = "";
}

/* ================= DASHBOARDS & BOOKINGS ================= */
function openUserDashboard() {
    const user = getCurrentUser();
    if (!user) return;
    hidePublicSections();

    document.getElementById("userDashboard").style.display = "block";
    document.getElementById("dashboardName").textContent = (user.name || "User").split(" ")[0];
    document.getElementById("dashboardFullName").textContent = user.name || "User";
    document.getElementById("dashboardEmail").textContent = user.email || "";
    document.getElementById("dashboardRole").textContent = "Customer";

    showUserTab("customerOverview", document.querySelector("#userDashboard .dashboard-tab"));
    renderCustomerBookings();
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function openProviderDashboard() {
    const user = getCurrentUser();
    if (!user) return;
    hidePublicSections();

    document.getElementById("providerDashboard").style.display = "block";
    document.getElementById("providerAccountEmail").textContent = user.email || "";
    refreshProviderHeader();

    showProviderTab("requestsTab", document.querySelector("#providerDashboard .dashboard-tab"));
    resetProviderStats();
    renderProviderRequests();
    window.scrollTo({ top: 0, behavior: "smooth" });
    maybeStartSpecialistOnboarding();
}

function showUserTab(tabId, button) {
    document.querySelectorAll("#userDashboard .user-tab-panel")
        .forEach(p => (p.style.display = p.id === tabId ? "block" : "none"));
    document.querySelectorAll("#userDashboard .dashboard-tab")
        .forEach(t => t.classList.remove("active"));
    if (button) button.classList.add("active");
    if (tabId === "customerBookings") renderCustomerBookings();
}

function showProviderTab(tabId, button) {
    document.querySelectorAll("#providerDashboard .provider-tab-panel")
        .forEach(p => (p.style.display = p.id === tabId ? "block" : "none"));
    document.querySelectorAll("#providerDashboard .dashboard-tab")
        .forEach(t => t.classList.remove("active"));
    if (button) button.classList.add("active");
    if (tabId === "requestsTab") renderProviderRequests();
    if (tabId === "specialistsTab") renderSpecialistEditor();
    if (tabId === "ratingsTab") renderProviderRatings();
}

/* ================= PROVIDER WORKSPACE: RATINGS TAB (NEW) =================
   Shows every customer rating + picture proof for the signed-in specialist.
   It reads the same review data the customer website uses, so both always match. */
function renderProviderRatings() {
    const user = getCurrentUser();
    const container = document.getElementById("providerRatingsList");
    if (!container || !user || user.role !== "Service Provider") return;

    const ctx = getEditorContext(user);
    const host = ctx.provider;

    if (!host || !ctx.entries.length) {
        container.innerHTML = `<p class="empty-review-text"><i class="fa-regular fa-star"></i> No specialist profile is linked to this account yet, so there are no ratings to show.</p>`;
        return;
    }

    container.innerHTML = ctx.entries.map(({ sp }) => {
        const reviews = getCombinedSpecialistReviews(host.businessName, sp);
        const stats = computeStarStats(reviews);

        const breakdown = [5, 4, 3, 2, 1].map(star => {
            const n = reviews.filter(r => Math.round(Number(r.rating) || 0) === star).length;
            const pct = reviews.length ? Math.round((n / reviews.length) * 100) : 0;
            return `
                <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
                    <span style="width:30px;">${star} ★</span>
                    <span style="flex:1; height:8px; background:#e5e7eb; border-radius:99px; overflow:hidden;">
                        <i style="display:block; height:100%; width:${pct}%; background:#f59e0b;"></i>
                    </span>
                    <span style="width:24px; text-align:right;">${n}</span>
                </div>`;
        }).join("");

        const cards = reviews.length
            ? reviews.map(rev => {
                const rounded = Math.max(0, Math.min(5, Math.round(Number(rev.rating) || 0)));
                const stars = "★".repeat(rounded) + "☆".repeat(5 - rounded);
                const caption = rev.proofCaption || "Served Properly — Verified Service Proof";
                return `
                    <article class="spec-proof-card">
                        <div class="spec-proof-card-top">
                            <div>
                                <strong><i class="fa-solid fa-circle-check verified-client-icon"></i> ${escapeHTML(rev.client)}</strong>
                                <span class="verified-tag">Served Client</span>
                            </div>
                            <span class="review-stars">${stars}</span>
                        </div>
                        <p class="spec-proof-comment">"${escapeHTML(rev.comment)}"</p>
                        ${rev.proofPhoto ? `
                            <div class="proof-photo-container" onclick="openProofLightbox('${escapeAttr(rev.proofPhoto)}', '${escapeAttr(caption)} — Client: ${escapeAttr(rev.client)}')">
                                <img src="${escapeHTML(rev.proofPhoto)}"
                                     alt="${escapeHTML(caption)}"
                                     onerror="this.src='https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=500&q=80'">
                                <span class="proof-zoom-badge"><i class="fa-solid fa-magnifying-glass-plus"></i> ${escapeHTML(caption)}</span>
                            </div>
                        ` : ""}
                        <small class="review-date">${escapeHTML(rev.date)}</small>
                    </article>`;
            }).join("")
            : `<p class="empty-review-text"><i class="fa-regular fa-star"></i> No ratings yet. Customers you serve can rate you after their booking is confirmed.</p>`;

        return `
            <article class="spec-editor-card">
                <h3 style="margin:0 0 4px;">${escapeHTML(sp.name)}</h3>
                <p style="margin:0 0 14px; color:#64748b;">${escapeHTML(sp.specialty || host.providerCategory || "")}</p>

                <div style="display:flex; flex-wrap:wrap; gap:24px; align-items:center; margin-bottom:18px;">
                    <div style="min-width:130px;">
                        <div style="font-size:34px; font-weight:800; line-height:1;">${stats.average}</div>
                        <div class="review-stars" style="margin:4px 0;">${stats.starsText}</div>
                        <small>${stats.count} ${stats.count === 1 ? "rating" : "ratings"}</small>
                    </div>
                    <div style="flex:1; min-width:220px; display:grid; gap:4px;">${breakdown}</div>
                </div>

                ${cards}
            </article>`;
    }).join("");
}

function extractPureSpecialistName(specialistField) {
    if (!specialistField) return "";
    return specialistField.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/* "View & Rate" on the confirmation banner:
   opens My Bookings, highlights that booking, then opens the specialist's rating window */
function viewAndRateBooking(id) {
    const user = getCurrentUser();
    if (!user) return;

    const booking = getBookings().find(b =>
        String(b.id) === String(id) &&
        (b.customerEmail || "").toLowerCase() === user.email.toLowerCase()
    );
    if (!booking) return showToast("We couldn't find that booking anymore.");

    // 1) show the My Bookings tab
    showUserTab("customerBookings", document.querySelectorAll("#userDashboard .dashboard-tab")[1]);

    // 2) bring that booking into view and highlight it
    const card = document.getElementById(`booking-card-${booking.id}`);
    if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("booking-highlight");
        setTimeout(() => card.classList.remove("booking-highlight"), 2600);
    }

    // 3) open the rating window of the specialist who confirmed it
    const specialistName = extractPureSpecialistName(booking.specialist);
    if (!specialistName || specialistName === "Any Available Specialist") {
        return showToast("This booking has no specific specialist to rate.");
    }
    const provider = getAllProvidersData().find(
        p => p.businessName.toLowerCase() === String(booking.provider).toLowerCase()
    );
    const specialist = provider && (provider.specialists || []).find(
        sp => sp.name.toLowerCase() === specialistName.toLowerCase()
    );
    if (!specialist) return showToast("This specialist's profile is no longer available.");

    setTimeout(() => openSpecialistReviewsModal(provider.businessName, specialist.name, true), 350);
}

function renderCustomerBookings() {
    const user = getCurrentUser();
    const container = document.getElementById("customerBookingList");
    const banner = document.getElementById("clientNotificationBanner");
    const badge = document.getElementById("confirmedBadge");
    if (!container || !user) return;

    const items = getBookings()
        .filter(item => item.customerEmail === user.email.toLowerCase())
        .reverse();

    const confirmedItems = items.filter(item => item.status === "Confirmed");

    if (badge) {
        badge.style.display = confirmedItems.length ? "inline-block" : "none";
        badge.textContent = confirmedItems.length;
    }

    if (banner) {
        if (confirmedItems.length > 0) {
            const latest = confirmedItems[0];
            const others = confirmedItems.length - 1;
            banner.style.display = "flex";
            banner.innerHTML = `
                <div>
                    <i class="fa-solid fa-circle-check"></i>
                    <strong>Booking Confirmed!</strong>
                    <span>${escapeHTML(latest.provider)} — ${escapeHTML(latest.specialist || "Specialist")} confirmed your booking on ${escapeHTML(formatSchedule(latest.schedule))}.</span>
                    ${others > 0 ? `<small class="banner-more">+${others} more confirmed booking${others > 1 ? "s" : ""} in My Bookings</small>` : ""}
                </div>
                <button type="button" class="banner-rate-btn" onclick="viewAndRateBooking('${escapeAttr(String(latest.id))}')">
                    <i class="fa-solid fa-star"></i> View & Rate
                </button>
            `;
        } else {
            banner.style.display = "none";
        }
    }

    container.innerHTML = items.length
        ? items.map(item => {
            const pureSpecName = extractPureSpecialistName(item.specialist);
            const canRate = item.status === "Confirmed" && pureSpecName && pureSpecName !== "Any Available Specialist";
            const channelTag = item.channel === "sms"
                ? `<span class="channel-pill sms"><i class="fa-solid fa-comment-sms"></i> Sent via SMS</span>`
                : `<span class="channel-pill email"><i class="fa-solid fa-envelope"></i> Sent via Email</span>`;

            return `
                <article class="request-card" id="booking-card-${escapeAttr(String(item.id))}">
                    <div>
                        <h3>${escapeHTML(item.provider)} ${channelTag}</h3>
                        <p><strong>Chosen Specialist & Company:</strong> ${escapeHTML(item.specialist || "Any Available Specialist")}</p>
                        ${item.problem ? `<p><strong>Problem:</strong> ${escapeHTML(item.problem)}</p>` : ""}
                        <p><strong>Schedule:</strong> ${escapeHTML(formatSchedule(item.schedule))}</p>
                        <p>${escapeHTML(item.message)}</p>
                        <small>Requested on ${new Date(item.date).toLocaleString()}</small>
                    </div>
                    <div class="request-controls">
                        <span class="request-status ${item.status.toLowerCase()}">
                            ${item.status === "Confirmed" ? "✓ Confirmed" : escapeHTML(item.status)}
                        </span>
                        ${canRate ? `
                            <button type="button"
                                    class="rate-from-booking-btn"
                                    onclick="openSpecialistReviewsModal('${escapeAttr(item.provider)}', '${escapeAttr(pureSpecName)}', true)">
                                <i class="fa-solid fa-star"></i> Rate & Upload Proof
                            </button>
                        ` : ""}
                    </div>
                </article>
            `;
        }).join("")
        : '<p class="empty-state">You have no bookings yet. Browse providers to request a service.</p>';
}

function renderProviderRequests() {
    const user = getCurrentUser();
    const container = document.getElementById("providerRequests");
    if (!container || !user) return;

    const allItems = getMyBookings(user).reverse();
    let items = allItems;
    if (providerRequestFilter) {
        items = allItems.filter(b => bookingMatchesStat(b, providerRequestFilter));
        // soonest appointment first for "Upcoming"
        if (providerRequestFilter === "upcoming") {
            items = [...items].sort((a, b) => new Date(a.schedule) - new Date(b.schedule));
        }
    }

    container.innerHTML = items.length
        ? items.map(item => `
            <article class="request-card">
                <div>
                    <h3>${escapeHTML(item.customerName)}</h3>
                    <p><strong>Requested Specialist:</strong> ${escapeHTML(item.specialist || "Any Available Specialist")}</p>
                    <p><strong>Client Contact:</strong> ${escapeHTML(item.customerEmail)} ${item.customerPhone ? `| ${escapeHTML(item.customerPhone)}` : ""}</p>
                    ${item.problem ? `<p><strong>Problem:</strong> ${escapeHTML(item.problem)}</p>` : ""}
                    <p><strong>Schedule:</strong> ${escapeHTML(formatSchedule(item.schedule))}</p>
                    <p>${escapeHTML(item.message)}</p>
                    <small>${new Date(item.date).toLocaleString()}</small>
                </div>
                <div class="request-controls">
                    <span class="request-status ${item.status.toLowerCase()}">
                        ${escapeHTML(item.status)}
                    </span>
                    ${item.status === "Pending" ? `
                        <button onclick="confirmAndNotifyBooking(${item.id})">Confirm & Notify Client</button>
                        <button class="cancel-request" onclick="updateBookingStatus(${item.id}, 'Cancelled')">Decline</button>
                    ` : ""}
                </div>
            </article>
        `).join("")
        : (providerRequestFilter && allItems.length
            ? `<p class="empty-state">No ${REQUEST_FILTER_LABELS[providerRequestFilter].toLowerCase()} requests right now.
                   <button type="button" class="empty-show-all" onclick="clearProviderRequestFilter()">Show all requests</button></p>`
            : '<p class="empty-state">No customer requests yet. Incoming bookings will appear here.</p>');

    syncRequestFilterUI(items.length, allItems.length);
    updateProviderStats();
}

async function confirmAndNotifyBooking(id) {
    const bookings = getBookings();
    const booking = bookings.find(req => req.id === id);
    if (!booking) return;

    booking.status = "Confirmed";
    saveBookings(bookings);
    renderProviderRequests();
    showToast(`Booking confirmed for ${booking.customerName}! Client can now rate & upload proof.`);
}

function updateBookingStatus(id, status) {
    const bookings = getBookings();
    const item = bookings.find(req => req.id === id);
    if (!item) return;
    const user = getCurrentUser();
    if (!user || !getMyBookingEmails(user).has((item.specialistEmail || "").toLowerCase())) {
        return showToast("You can only manage requests addressed to you.");
    }
    item.status = status;
    saveBookings(bookings);
    renderProviderRequests();
    showToast(`Request ${status.toLowerCase()}.`);
}

function renameProviderCardInDom(oldName, newName) {
    const card = [...document.querySelectorAll(".provider-card")].find(
        c => (c.dataset.name || "").toLowerCase() === oldName.toLowerCase()
    );
    if (!card) return null;

    card.dataset.name = newName;
    const title = card.querySelector("h3");
    if (title) title.textContent = newName;

    const buttons = card.querySelectorAll(".provider-actions button");
    if (buttons[0]) buttons[0].setAttribute("onclick", `viewProvider('${escapeAttr(newName)}')`);
    if (buttons[1]) buttons[1].setAttribute("onclick", `openInquiry('${escapeAttr(newName)}')`);
    return card;
}

/* On page load: a built-in provider that was renamed keeps ONE card, under its new name */
function reconcileRenamedProviders() {
    getUsers()
        .filter(u => u.role === "Service Provider" && u.businessName)
        .forEach(u => {
            const base = DEFAULT_PROVIDERS.find(d => String(d.email).toLowerCase() === String(u.email).toLowerCase());
            if (base && base.businessName.toLowerCase() !== u.businessName.toLowerCase()) {
                renameProviderCardInDom(base.businessName, u.businessName);
            }
        });
}

/* Make the customer-facing website show the latest data right now */
function refreshWebsiteAfterProviderChange(businessName) {
    syncHomepageProviderCards();
    applyProviderFilters();
    updateHeroStats();
    refreshOpenSpecialistReviewHeader();

    const profileModal = document.getElementById("profileModal");
    if (profileModal && profileModal.style.display === "flex" && currentProvider &&
        String(currentProvider).toLowerCase() === String(businessName).toLowerCase()) {
        viewProvider(currentProvider);
    }
}

/* ================= SPECIALIST EDITOR (provider workspace) ================= */
const SPECIALIST_PRICE_UNITS = ["service", "hour", "day", "session", "visit", "project", "trip", "event", "package"];
const SPECIALIST_GENDERS = ["Male", "Female", "Non-binary", "Not specified"];
const DEFAULT_SPECIALIST_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='#e0e7ff'/>" +
    "<circle cx='60' cy='46' r='22' fill='#818cf8'/><path d='M18 112c4-26 22-38 42-38s38 12 42 38z' fill='#818cf8'/></svg>"
);
let pendingSpecialistPhotos = {};

function getOwnProviderData(user) {
    const name = getProviderBusiness(user).toLowerCase();
    return getAllProvidersData().find(p => p.businessName.toLowerCase() === name) || null;
}

function specOptions(list, current) {
    const items = current && !list.some(x => x.toLowerCase() === String(current).toLowerCase()) ? [...list, current] : list;
    return items
        .map(x => `<option value="${escapeAttr(x)}" ${String(x).toLowerCase() === String(current || "").toLowerCase() ? "selected" : ""}>${escapeHTML(x)}</option>`)
        .join("");
}

/* A profile belongs to the account whose sign-in email matches it.
   "ownerEmail" is saved the first time the profile is edited, so the profile's contact email
   can be changed later without losing access to it. */
function isOwnedBy(sp, email) {
    const target = String(email || "").trim().toLowerCase();
    return !!target && String(sp.ownerEmail || sp.email || "").trim().toLowerCase() === target;
}

/* Which specialist profiles may this account edit, and where are they stored? */
function findListedSpecialistByEmail(email) {
    for (const provider of getAllProvidersData()) {
        const own = (provider.specialists || []).filter(sp => !sp.joined);
        const index = own.findIndex(sp => isOwnedBy(sp, email));
        if (index >= 0) return { provider, sp: own[index], listIndex: index };
    }
    return null;
}

function findSpecialistNameInDirectory(name) {
    const target = String(name || "").trim().toLowerCase();
    if (!target) return null;
    for (const provider of getAllProvidersData()) {
        const hit = (provider.specialists || []).find(sp => String(sp.name || "").trim().toLowerCase() === target);
        if (hit) return { provider, sp: hit };
    }
    return null;
}

function getEditorContext(user) {
    if (!isSpecialistAccount(user)) {
        const provider = getOwnProviderData(user);
        const own = (provider?.specialists || []).filter(sp => !sp.joined);
        // Privacy: only the specialist whose email matches the sign-in email is shown
        const entries = own
            .map((sp, i) => ({ sp, listIndex: i }))
            .filter(entry => isOwnedBy(entry.sp, user.email));
        return { mode: "business", provider, entries };
    }

    const email = String(user.email).toLowerCase();
    const joined = getJoinedSpecialists()[email];
    if (joined && joined.specialist) {
        const providers = getAllProvidersData();
        const host = providers[findCategoryHostIndex(providers, joined.category)] || null;
        return { mode: "joined", provider: host, category: joined.category, entries: [{ sp: joined.specialist, listIndex: 0 }] };
    }

    // Already listed in the directory under the same verified email: no new profile needed
    const listed = findListedSpecialistByEmail(email);
    if (listed) {
        return { mode: "linked", provider: listed.provider, category: listed.provider.providerCategory, entries: [{ sp: listed.sp, listIndex: listed.listIndex }] };
    }

    return { mode: "pending", provider: null, entries: [] };
}

/* Booking requests are private too: an account only sees requests addressed to its own specialist email(s) */
function getMyBookingEmails(user) {
    const emails = new Set([String(user.email).toLowerCase()]);
    getEditorContext(user).entries.forEach(entry => {
        if (entry.sp.email) emails.add(String(entry.sp.email).toLowerCase());
    });
    return emails;
}

/* The bookings that belong to this account (same rule as the Customer Requests list) */
function getMyBookings(user) {
    const mine = getMyBookingEmails(user);
    return getBookings().filter(b => mine.has((b.specialistEmail || "").toLowerCase()));
}

/* One rule for every card, so a number always equals the list you get when you click it.
   Upcoming = confirmed bookings whose date/time has not passed yet. */
function bookingMatchesStat(booking, key) {
    switch (key) {
        case "confirmed": return booking.status === "Confirmed";
        case "pending":   return booking.status === "Pending";
        case "cancelled": return booking.status === "Cancelled";
        case "upcoming": {
            const when = new Date(booking.schedule).getTime();
            return booking.status === "Confirmed" && !isNaN(when) && when >= Date.now();
        }
        default: return true;
    }
}

function computeProviderStats(user) {
    const stats = { upcoming: 0, confirmed: 0, pending: 0, cancelled: 0 };
    getMyBookings(user).forEach(b => {
        Object.keys(stats).forEach(key => {
            if (bookingMatchesStat(b, key)) stats[key] += 1;
        });
    });
    return stats;
}

const PROVIDER_STAT_KEYS = ["upcoming", "confirmed", "pending", "cancelled"];
let providerSeenBookingIds = null;

/* ---- clicking a stat card filters the Incoming Customer Requests list ---- */
const REQUEST_FILTER_LABELS = { upcoming: "Upcoming", confirmed: "Confirmed", pending: "Pending", cancelled: "Cancelled" };
let providerRequestFilter = null;

function filterProviderRequests(key) {
    providerRequestFilter = providerRequestFilter === key ? null : key;   // click again = show all

    const requestsTab = document.getElementById("requestsTab");
    if (getComputedStyle(requestsTab).display === "none") {
        showProviderTab("requestsTab", document.querySelector("#providerDashboard .dashboard-tab"));
    } else {
        renderProviderRequests();
    }
    requestsTab.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearProviderRequestFilter() {
    providerRequestFilter = null;
    renderProviderRequests();
}

function syncRequestFilterUI(shown, total) {
    document.querySelectorAll("#providerStats .stat-card").forEach(card => {
        const active = card.dataset.stat === providerRequestFilter;
        card.classList.toggle("active", active);
        card.setAttribute("aria-pressed", active ? "true" : "false");
    });

    const bar = document.getElementById("requestFilterBar");
    if (!bar) return;
    if (!providerRequestFilter) {
        bar.style.display = "none";
        bar.innerHTML = "";
        return;
    }
    bar.style.display = "flex";
    bar.innerHTML = `
        <span><i class="fa-solid fa-filter"></i> Showing <strong>${REQUEST_FILTER_LABELS[providerRequestFilter]}</strong> requests
            <em>(${shown} of ${total})</em></span>
        <button type="button" onclick="clearProviderRequestFilter()"><i class="fa-solid fa-xmark"></i> Show all</button>
    `;
}

function resetProviderStats() {
    providerSeenBookingIds = null;
    providerRequestFilter = null;
    PROVIDER_STAT_KEYS.forEach(key => {
        const el = document.getElementById("provStat_" + key);
        if (el) {
            delete el.dataset.value;
            el.textContent = "0";
        }
    });
}

function animateStatNumber(el, from, to) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.textContent = to;
        return;
    }
    const start = performance.now();
    const duration = 500;
    const tick = now => {
        const t = Math.min((now - start) / duration, 1);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = to;
    };
    requestAnimationFrame(tick);
}

/* Recount and show the numbers. Called every time bookings change, so the tally is always current. */
function updateProviderStats() {
    const user = getCurrentUser();
    const panel = document.getElementById("providerStats");
    if (!panel || !user || user.role !== "Service Provider") return;

    const stats = computeProviderStats(user);
    PROVIDER_STAT_KEYS.forEach(key => {
        const el = document.getElementById("provStat_" + key);
        if (!el) return;
        const next = stats[key];
        const prev = el.dataset.value === undefined ? null : Number(el.dataset.value);
        if (prev === next) return;

        el.dataset.value = next;
        if (prev === null) {
            el.textContent = next;
            return;
        }
        animateStatNumber(el, prev, next);
        const card = el.closest(".stat-card");
        if (card) {
            card.classList.remove("bump");
            void card.offsetWidth;
            card.classList.add("bump");
        }
    });

    // Tell the specialist the moment a new request arrives
    const mine = getMyBookings(user);
    if (providerSeenBookingIds === null) {
        providerSeenBookingIds = new Set(mine.map(b => b.id));
    } else {
        const fresh = mine.filter(b => !providerSeenBookingIds.has(b.id));
        fresh.forEach(b => providerSeenBookingIds.add(b.id));
        const freshPending = fresh.filter(b => b.status === "Pending");
        if (freshPending.length === 1) showToast(`New booking request from ${freshPending[0].customerName}!`);
        else if (freshPending.length > 1) showToast(`${freshPending.length} new booking requests!`);
    }
}

function getProviderDisplayName(user) {
    if (isSpecialistAccount(user)) {
        const ctx = getEditorContext(user);
        return ctx.entries[0]?.sp.name || user.name || "Specialist";
    }
    return getProviderBusiness(user);
}

function updateSpecialistTabLabels(ctx) {
    const single = ctx.mode !== "business";
    const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    set("specialistsTabBtn", single ? "My Profile" : "My Specialists");
    set("specialistsTabTitle", single ? "My Specialist Profile" : "My Specialists");
    set("specialistsTabHint", single
        ? "Edit your photo and details. Saved changes appear on the customer website right away."
        : "Only the specialist profile linked to your sign-in email appears here. Saved changes appear on the customer website right away.");
}

function refreshProviderHeader() {
    const user = getCurrentUser();
    if (!user || user.role !== "Service Provider") return;

    const name = getProviderDisplayName(user);
    const welcome = document.getElementById("providerWelcomeName");
    const title = document.getElementById("providerBusinessName");
    if (welcome) welcome.textContent = name;
    if (title) title.textContent = name;

    const ctx = getEditorContext(user);
    updateSpecialistTabLabels(ctx);
    updateSpecialistOnboardBanner(ctx);
}

function specialistPhotoBlock(sp, key, title) {
    return `
        <div class="spec-editor-photo">
            <img id="specEditPhoto-${key}" src="${escapeAttr(sp.photo || DEFAULT_SPECIALIST_AVATAR)}"
                 alt="${escapeAttr(sp.name || "Specialist")}"
                 onerror="this.onerror=null;this.src=DEFAULT_SPECIALIST_AVATAR">
            <div class="spec-editor-photo-actions">
                <strong>${escapeHTML(title || sp.name || "Your photo")}</strong>
                <div>
                    <label class="photo-upload-btn">
                        <i class="fa-solid fa-camera"></i> Change photo
                        <input type="file" accept="image/*" hidden onchange="previewSpecialistPhoto(this, '${key}')">
                    </label>
                    <button type="button" class="photo-remove-btn" onclick="removeSpecialistPhoto('${key}')">
                        <i class="fa-solid fa-trash-can"></i> Remove
                    </button>
                </div>
                <small id="specPhotoNote-${key}">JPG or PNG. We resize it automatically.</small>
            </div>
        </div>`;
}

function specialistFieldsGrid(sp, fallbackEmail) {
    return `
        <div class="spec-editor-grid">
            <label>Full name
                <input name="name" type="text" maxlength="60" required value="${escapeAttr(sp.name || "")}">
            </label>
            <label><span>Company / Business <small>(optional)</small></span>
                <input name="company" type="text" maxlength="80" placeholder="Independent" value="${escapeAttr(sp.company || "")}">
            </label>
            <label>Specialty
                <input name="specialty" type="text" maxlength="120" required value="${escapeAttr(sp.specialty || "")}">
            </label>
            <label>Price Range (₱)
                <span style="display:flex; gap:8px; align-items:center;">
                    <input name="price" type="number" min="0" step="1" placeholder="Minimum" style="flex:1; min-width:0;" value="${escapeAttr(sp.price ?? "")}">
                    <span>to</span>
                    <input name="priceMax" type="number" min="0" step="1" placeholder="Maximum" style="flex:1; min-width:0;" value="${escapeAttr(sp.priceMax || "")}">
                </span>
            </label>
            <label>Price per
                <select name="priceUnit">${specOptions(SPECIALIST_PRICE_UNITS, sp.priceUnit || "service")}</select>
            </label>
            <label>Age
                <input name="age" type="number" min="18" max="99" required value="${escapeAttr(sp.age ?? "")}">
            </label>
            <label>Gender
                <select name="gender">${specOptions(SPECIALIST_GENDERS, sp.gender || "Not specified")}</select>
            </label>
            <label>City / Municipality
                <input name="city" type="text" list="specialistCityOptions" maxlength="60" required value="${escapeAttr(sp.city || "")}">
            </label>
            <label class="span-2">Address
                <input name="address" type="text" maxlength="120" required value="${escapeAttr(sp.address || "")}">
            </label>
            <label>Contact number (SMS)
                <input name="contact" type="text" maxlength="20" required placeholder="0917-555-0100" value="${escapeAttr(sp.contact || "")}">
            </label>
            <label>Email (bookings are sent here)
                <input name="email" type="email" required value="${escapeAttr(sp.email || fallbackEmail || "")}">
            </label>
            <label class="span-2"><span>Bio <small>(one line per bullet, up to 6)</small></span>
                <textarea name="bio" rows="3" maxlength="600">${escapeHTML((sp.bio || []).join("\n"))}</textarea>
            </label>
        </div>`;
}

/* Reads + validates a specialist form. Shows a message and returns null when something is wrong. */
function collectSpecialistForm(form, photo, takenNames, defaultCompany) {
    const f = form.elements;
    const name = f.name.value.trim().replace(/\s+/g, " ");
    const email = f.email.value.trim().toLowerCase();
    const contact = f.contact.value.trim();
    const age = Number(f.age.value);
    const priceRaw = f.price.value.trim();
    const priceMaxRaw = f.priceMax ? f.priceMax.value.trim() : "";
    const bio = f.bio.value.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 6);
    const fail = message => {
        showToast(message);
        return null;
    };

    if (name.length < 2) return fail("Please enter the specialist's full name.");
    if (takenNames.some(n => String(n).trim().toLowerCase() === name.toLowerCase())) {
        return fail("Another specialist already uses that name.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("Please enter a valid email address.");
    if (!/^[0-9+\-()\s]{7,20}$/.test(contact)) return fail("Please enter a valid contact number.");
    if (!Number.isInteger(age) || age < 18 || age > 99) return fail("Age must be between 18 and 99.");
    if (priceRaw !== "" && (isNaN(Number(priceRaw)) || Number(priceRaw) < 0)) return fail("Please enter a valid price.");
    if (priceMaxRaw !== "" && (isNaN(Number(priceMaxRaw)) || Number(priceMaxRaw) < 0)) return fail("Please enter a valid maximum price.");
    if (priceMaxRaw !== "" && priceRaw === "") return fail("Please enter the minimum price too.");
    if (priceMaxRaw !== "" && Number(priceMaxRaw) < Number(priceRaw)) return fail("The maximum price can't be lower than the minimum price.");

    return {
        name,
        company: f.company.value.trim() || defaultCompany,
        specialty: f.specialty.value.trim(),
        price: priceRaw === "" ? 0 : Number(priceRaw),
        priceMax: priceMaxRaw === "" ? 0 : Number(priceMaxRaw),
        priceUnit: f.priceUnit.value || "service",
        age,
        gender: f.gender.value,
        address: f.address.value.trim(),
        city: f.city.value.trim() || f.address.value.trim(),
        contact,
        email,
        photo,
        bio
    };
}

function renderSpecialistEditor() {
    const user = getCurrentUser();
    const container = document.getElementById("providerSpecialistList");
    if (!container || !user) return;

    pendingSpecialistPhotos = {};

    const cityList = document.getElementById("specialistCityOptions");
    if (cityList) {
        cityList.innerHTML = AVAILABLE_LOCATIONS.map(l => `<option value="${escapeAttr(l.name)}"></option>`).join("");
    }

    const ctx = getEditorContext(user);
    updateSpecialistTabLabels(ctx);

    if (ctx.mode === "pending") {
        container.innerHTML = `
            <div class="spec-editor-card onboard-cta">
                <h3>Finish setting up your specialist profile</h3>
                <p>Customers can't find you yet. Fill in your profile and choose your service category to appear on the website.</p>
                <button type="button" class="main-button" onclick="openSpecialistOnboarding()">Set Up My Profile</button>
            </div>`;
        return;
    }

    const listedUnder = ctx.mode !== "business"
        ? `<p class="spec-listed-under"><i class="fa-solid fa-tag"></i> Listed under <strong>${escapeHTML(ctx.category || "")}</strong>${ctx.provider ? ` with ${escapeHTML(ctx.provider.businessName)}` : ""}</p>`
        : "";
    const privacyLine = `<p class="spec-listed-under"><i class="fa-solid fa-lock"></i> Signed in as <strong>${escapeHTML(user.email)}</strong>. Only the profile linked to this email is shown and can be edited here.</p>`;

    container.innerHTML = privacyLine + listedUnder + (ctx.entries.length
        ? ctx.entries.map(({ sp }, i) => `
            <article class="spec-editor-card" id="specEditor-${i}">
                <form class="spec-editor-form" onsubmit="saveSpecialist(event, ${i})">
                    ${specialistPhotoBlock(sp, i, sp.name)}
                    ${specialistFieldsGrid(sp, ctx.provider?.email)}
                    <div class="spec-editor-actions">
                        <button type="submit" class="main-button"><i class="fa-solid fa-floppy-disk"></i> Save Changes</button>
                        <button type="button" class="spec-discard-btn" onclick="renderSpecialistEditor()">Discard</button>
                    </div>
                </form>
            </article>
        `).join("")
        : `<div class="spec-editor-card onboard-cta">
                <h3>No specialist profile is linked to this email</h3>
                <p>For privacy, each specialist can only see and edit their own profile. To manage a profile, sign in with the email address that is saved on that specialist's listing.</p>
           </div>`);
}

/* Crop to a centered square and shrink, so the photo is small enough to store */
function shrinkImageToSquare(file, size = 400) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                const side = Math.min(img.width, img.height);
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = size;
                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, size, size);
                ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function previewSpecialistPhoto(input, index) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        input.value = "";
        return showToast("Please choose an image file (JPG or PNG).");
    }
    if (file.size > 12 * 1024 * 1024) {
        input.value = "";
        return showToast("That photo is too large. Please choose one under 12 MB.");
    }
    try {
        const dataUrl = await shrinkImageToSquare(file);
        pendingSpecialistPhotos[index] = dataUrl;
        document.getElementById(`specEditPhoto-${index}`).src = dataUrl;
        const note = document.getElementById(`specPhotoNote-${index}`);
        if (note) note.textContent = "New photo ready. Click Save Changes to publish it.";
    } catch {
        showToast("We couldn't read that image. Please try another one.");
    }
}

function removeSpecialistPhoto(index) {
    pendingSpecialistPhotos[index] = DEFAULT_SPECIALIST_AVATAR;
    document.getElementById(`specEditPhoto-${index}`).src = DEFAULT_SPECIALIST_AVATAR;
    const note = document.getElementById(`specPhotoNote-${index}`);
    if (note) note.textContent = "Photo removed. Click Save Changes to apply.";
}

function saveSpecialist(event, index) {
    event.preventDefault();
    const user = getCurrentUser();
    if (!user || user.role !== "Service Provider") return;

    const ctx = getEditorContext(user);
    const entry = ctx.entries[index];
    if (!entry || !ctx.provider) return showToast("We couldn't find your provider profile.");

    const current = entry.sp;
    const me = String(user.email).toLowerCase();

    // Names already used by the OTHER specialists of the same category group
    const takenNames = (ctx.provider.specialists || [])
        .filter(sp => (ctx.mode === "joined" ? !(sp.joined && sp.ownerEmail === me) : sp !== current))
        .map(sp => sp.name);

    const photo = pendingSpecialistPhotos[index] || current.photo || DEFAULT_SPECIALIST_AVATAR;
    const fields = collectSpecialistForm(
        event.target, photo, takenNames,
        ctx.mode === "joined" ? "Independent" : ctx.provider.businessName
    );
    if (!fields) return;

    const previous = { ...current };
    const updated = { ...current, ...fields };
    if (ctx.mode !== "joined") updated.ownerEmail = me;

    try {
        if (ctx.mode === "joined") {
            const joined = getJoinedSpecialists();
            joined[me] = { ...joined[me], specialist: updated };
            saveJoinedSpecialists(joined);
        } else {
            const list = (ctx.provider.specialists || [])
                .filter(sp => !sp.joined)
                .map(sp => ({ ...sp, bio: [...(sp.bio || [])] }));
            list[entry.listIndex] = updated;
            const edited = getSpecialistOverrides();
            edited[String(ctx.provider.email).toLowerCase()] = list;
            saveSpecialistOverrides(edited);
        }
    } catch {
        return showToast("Your browser is out of storage. Try a smaller photo.");
    }

    migrateSpecialistIdentity(ctx.provider.businessName, previous, updated);
    delete pendingSpecialistPhotos[index];

    renderSpecialistEditor();
    refreshProviderHeader();
    refreshWebsiteAfterProviderChange(ctx.provider.businessName);
    showToast(`${updated.name}'s profile was updated on the website.`);
}

/* ================= SPECIALIST ONBOARDING: profile form -> choose category ================= */
function needsSpecialistOnboarding(user) {
    return isSpecialistAccount(user) && getEditorContext(user).mode === "pending";
}

function persistUserPatch(patch) {
    const user = getCurrentUser();
    if (!user) return null;
    const users = getUsers();
    const index = users.findIndex(u => String(u.email).toLowerCase() === String(user.email).toLowerCase());
    if (index >= 0) {
        users[index] = { ...users[index], ...patch };
        saveUsers(users);
    }
    const next = { ...user, ...patch };
    setCurrentUser(next);
    return next;
}

function updateSpecialistOnboardBanner(ctx) {
    const banner = document.getElementById("specialistOnboardBanner");
    const user = getCurrentUser();
    if (!banner) return;

    const pending = !!user && isSpecialistAccount(user) && (ctx || getEditorContext(user)).mode === "pending";
    banner.style.display = pending ? "flex" : "none";
    banner.innerHTML = pending
        ? `<div>
                <i class="fa-solid fa-circle-info"></i>
                <strong>Almost there!</strong>
                <span>Finish your specialist profile and choose a category so customers can find you.</span>
           </div>
           <button type="button" class="banner-rate-btn" onclick="openSpecialistOnboarding()">Continue setup</button>`
        : "";
}

/* Right after a Service Provider signs in: if they are not listed yet, open the profile form */
function maybeStartSpecialistOnboarding() {
    const user = getCurrentUser();
    if (!user || !needsSpecialistOnboarding(user)) return;
    setTimeout(openSpecialistOnboarding, 350);
}

function openSpecialistOnboarding() {
    const user = getCurrentUser();
    if (!user || !needsSpecialistOnboarding(user)) return;

    closeAllModals();
    pendingSpecialistPhotos.onboard = undefined;
    document.getElementById("specialistOnboardModal").style.display = "flex";

    const cityList = document.getElementById("specialistCityOptions");
    if (cityList) {
        cityList.innerHTML = AVAILABLE_LOCATIONS.map(l => `<option value="${escapeAttr(l.name)}"></option>`).join("");
    }

    if (user.pendingSpecialist) renderOnboardStep2();
    else renderOnboardStep1(null);
}

function closeSpecialistOnboarding() {
    document.getElementById("specialistOnboardModal").style.display = "none";
    refreshProviderHeader();
}

function onboardStepsHtml(active) {
    return `
        <div class="onboard-steps">
            <span class="${active === 1 ? "active" : "done"}"><b>1</b> Your profile</span>
            <i></i>
            <span class="${active === 2 ? "active" : ""}"><b>2</b> Category</span>
        </div>`;
}

function renderOnboardStep1(draft, notice) {
    const user = getCurrentUser();
    const body = document.getElementById("onboardBody");
    if (!user || !body) return;

    const sp = draft || {
        name: user.name, email: user.email, company: "", specialty: "", price: "",
        priceUnit: "service", age: "", gender: "Not specified", city: "", address: "",
        contact: "", bio: [], photo: DEFAULT_SPECIALIST_AVATAR
    };

    // Heads-up when someone with the same name is already listed
    let message = notice || "";
    if (!draft && !message) {
        const same = findSpecialistNameInDirectory(user.name);
        if (same) {
            message = `A specialist named "${same.sp.name}" is already listed under ${same.provider.providerCategory}. If that isn't you, please use a more specific name (for example, add your middle initial).`;
        }
    }

    body.innerHTML = `
        ${onboardStepsHtml(1)}
        <h2>Set up your specialist profile</h2>
        <p class="onboard-sub">This is what customers will see on the website. You can edit it anytime in <strong>My Profile</strong>.</p>
        ${message ? `<div class="onboard-notice"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHTML(message)}</div>` : ""}
        <form class="spec-editor-form" onsubmit="submitOnboardProfile(event)">
            ${specialistPhotoBlock(sp, "onboard", "Your photo")}
            ${specialistFieldsGrid(sp, user.email)}
            <div class="spec-editor-actions">
                <button type="submit" class="main-button">Save &amp; Continue <i class="fa-solid fa-arrow-right"></i></button>
                <button type="button" class="spec-discard-btn" onclick="closeSpecialistOnboarding()">Finish later</button>
            </div>
        </form>
    `;
    document.getElementById("specialistOnboardModal").scrollTop = 0;
    body.closest(".modal-content").scrollTop = 0;
}

function submitOnboardProfile(event) {
    event.preventDefault();
    const user = getCurrentUser();
    if (!user) return;

    const photo = pendingSpecialistPhotos.onboard || user.pendingSpecialist?.photo || DEFAULT_SPECIALIST_AVATAR;
    const data = collectSpecialistForm(event.target, photo, [], "Independent");
    if (!data) return;

    try {
        persistUserPatch({ pendingSpecialist: { ...data, reviews: [] } });
    } catch {
        return showToast("Your browser is out of storage. Try a smaller photo.");
    }
    pendingSpecialistPhotos.onboard = undefined;
    renderOnboardStep2();
}

function renderOnboardStep2() {
    const user = getCurrentUser();
    const body = document.getElementById("onboardBody");
    if (!user || !body) return;

    const providers = getAllProvidersData();
    const options = getServiceCategories().map(category => {
        const host = providers[findCategoryHostIndex(providers, category)];
        const count = host ? (host.specialists || []).length : 0;
        return `
            <label class="cat-option">
                <input type="radio" name="onboardCategory" value="${escapeAttr(category)}" onchange="selectOnboardCategory(this)">
                <i class="fa-solid ${getCategoryIconClass(category).icon}"></i>
                <span class="cat-option-name">${escapeHTML(category)}</span>
                <small>${count} specialist${count === 1 ? "" : "s"}</small>
            </label>`;
    }).join("");

    body.innerHTML = `
        ${onboardStepsHtml(2)}
        <h2>Which category are you in?</h2>
        <p class="onboard-sub">Choose where customers should find <strong>${escapeHTML(user.pendingSpecialist?.name || user.name)}</strong>. You'll be added to that category's list of specialists.</p>
        <div class="cat-grid">${options}</div>
        <div class="spec-editor-actions">
            <button type="button" class="main-button" id="onboardJoinBtn" onclick="joinSelectedCategory()" disabled>
                <i class="fa-solid fa-check"></i> Join this category
            </button>
            <button type="button" class="spec-discard-btn" onclick="renderOnboardStep1(getCurrentUser().pendingSpecialist)">Back</button>
        </div>
    `;
    body.closest(".modal-content").scrollTop = 0;
}

function selectOnboardCategory(input) {
    document.querySelectorAll("#onboardBody .cat-option").forEach(label => label.classList.remove("selected"));
    input.closest(".cat-option")?.classList.add("selected");
    const button = document.getElementById("onboardJoinBtn");
    if (button) button.disabled = false;
}

function joinSelectedCategory() {
    const user = getCurrentUser();
    const draft = user?.pendingSpecialist;
    if (!user || !draft) return;

    const category = document.querySelector('input[name="onboardCategory"]:checked')?.value;
    if (!category) return showToast("Please choose a category first.");

    const providers = getAllProvidersData();
    const host = providers[findCategoryHostIndex(providers, category)];
    if (!host) return showToast("That category isn't available right now.");

    // Names must be unique inside a category group (reviews and bookings are tied to the name)
    const taken = (host.specialists || []).some(
        sp => String(sp.name).trim().toLowerCase() === draft.name.trim().toLowerCase()
    );
    if (taken) {
        showToast(`${category} already has a specialist named ${draft.name}.`);
        return renderOnboardStep1(draft, "A specialist with this name already exists in that category. Please make your name more specific (for example, add your middle initial) and choose the category again.");
    }

    const joined = getJoinedSpecialists();
    joined[String(user.email).toLowerCase()] = { category, specialist: { ...draft, reviews: [] } };
    try {
        saveJoinedSpecialists(joined);
    } catch {
        return showToast("Your browser is out of storage. Try a smaller photo.");
    }
    persistUserPatch({ pendingSpecialist: null });

    closeSpecialistOnboarding();
    refreshWebsiteAfterProviderChange(host.businessName);
    showProviderTab("specialistsTab", document.getElementById("specialistsTabBtn"));
    showToast(`You're now listed under ${category}!`);
}

/* If the name or company changed, keep the specialist's reviews and past bookings attached */
function migrateSpecialistIdentity(providerName, before, after) {
    const oldName = before.name.trim().toLowerCase();

    if (oldName !== after.name.trim().toLowerCase()) {
        const reviews = getCustomSpecialistReviews();
        const oldKey = makeSpecialistKey(providerName, before.name);
        const newKey = makeSpecialistKey(providerName, after.name);
        if (reviews[oldKey]) {
            reviews[newKey] = [...(reviews[newKey] || []), ...reviews[oldKey]];
            delete reviews[oldKey];
            saveCustomSpecialistReviews(reviews);
        }
    }

    const label = after.company ? `${after.name} (${after.company})` : after.name;
    const bookings = getBookings();
    let changed = false;
    bookings.forEach(b => {
        if (String(b.provider).trim().toLowerCase() !== providerName.trim().toLowerCase()) return;
        if (extractPureSpecialistName(b.specialist).toLowerCase() !== oldName) return;
        if (b.specialist !== label) {
            b.specialist = label;
            changed = true;
        }
        const oldEmail = String(before.email || "").toLowerCase();
        if (oldEmail && String(b.specialistEmail || "").toLowerCase() === oldEmail &&
            oldEmail !== String(after.email || "").toLowerCase()) {
            b.specialistEmail = after.email;
            changed = true;
        }
    });
    if (changed) saveBookings(bookings);
}

function refreshOpenSpecialistReviewHeader() {
    const modal = document.getElementById("specialistReviewModal");
    if (!modal || modal.style.display !== "flex") return;

    const provider = getAllProvidersData().find(
        p => p.businessName.toLowerCase() === String(activeReviewProviderName).toLowerCase()
    );
    const specialist = provider && (provider.specialists || []).find(
        sp => sp.name.toLowerCase() === String(activeReviewSpecialistName).toLowerCase()
    );
    if (!specialist) {
        closeModal("specialistReviewModal");
        return;
    }

    document.getElementById("specModalPhoto").src = specialist.photo || DEFAULT_SPECIALIST_AVATAR;
    document.getElementById("specModalCompany").textContent = specialist.company || provider.businessName;
    document.getElementById("specModalName").textContent = specialist.name;
    document.getElementById("specModalSpecialty").textContent = specialist.specialty || provider.providerCategory;
}

function previewProviderOnWebsite() {
    const user = getCurrentUser();
    if (!user) return;
    const ctx = getEditorContext(user);
    const target = ctx.provider ? ctx.provider.businessName : getProviderBusiness(user);
    showHomePage();
    setTimeout(() => viewProvider(target), 80);
}

/* ================= ACCURATE SEARCH, FILTER & FAVORITES ================= */
function toggleMenu() {
    document.getElementById("navLinks")?.classList.toggle("active");
}

function normalizeLocationString(str) {
    return String(str || "")
        .toLowerCase()
        .replace(/\bcity\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function buildProviderSearchIndex(card, allProvidersMap) {
    const providerName = (card.dataset.name || "").trim();
    const providerData = allProvidersMap.get(providerName.toLowerCase());

    const parts = [
        providerName,
        card.dataset.category || "",
        card.dataset.location || "",
        card.innerText || ""
    ];

    const locationsList = [card.dataset.location || ""];

    if (providerData) {
        parts.push(
            providerData.serviceTitle || "",
            providerData.providerDescription || "",
            providerData.ownerName || ""
        );
        (providerData.specialists || []).forEach(spec => {
            parts.push(
                spec.name || "",
                spec.company || "",
                spec.specialty || "",
                spec.address || "",
                spec.city || "",
                (spec.bio || []).join(" ")
            );
            if (spec.city) locationsList.push(spec.city);
            if (spec.address) locationsList.push(spec.address);
        });
    }

    return {
        fullText: parts.join(" ").toLowerCase(),
        locationsRaw: locationsList.join(" | ").toLowerCase(),
        locationsNormalized: normalizeLocationString(locationsList.join(" | "))
    };
}

function applyProviderFilters() {
    const rawSearch = document.getElementById("searchInput")?.value || "";
    const rawLocation = document.getElementById("locationInput")?.value || "";
    const selectedCategory = document.getElementById("categoryFilter")?.value || "all";

    const searchTerm = rawSearch.toLowerCase().trim();
    const searchTokens = searchTerm.split(/\s+/).filter(Boolean);

    const locationTerm = rawLocation.toLowerCase().trim();
    const normalizedLocationTerm = normalizeLocationString(rawLocation);

    // Toggle clear buttons
    const clearSvcBtn = document.getElementById("clearServiceBtn");
    if (clearSvcBtn) clearSvcBtn.style.display = rawSearch.trim() ? "inline-flex" : "none";
    const clearLocBtn = document.getElementById("clearLocationBtn");
    if (clearLocBtn) clearLocBtn.style.display = rawLocation.trim() ? "inline-flex" : "none";

    const allProvidersMap = new Map(
        getAllProvidersData().map(p => [p.businessName.toLowerCase(), p])
    );

    const cards = [...document.querySelectorAll(".provider-card")];
    let visibleCount = 0;

    cards.forEach(card => {
        const index = buildProviderSearchIndex(card, allProvidersMap);

        const categoryMatch = selectedCategory === "all" ||
            (card.dataset.category || "").toLowerCase() === selectedCategory.toLowerCase();

        const serviceMatch = searchTokens.length === 0 ||
            searchTokens.every(token => index.fullText.includes(token));

        const locationMatch = !locationTerm ||
            index.locationsRaw.includes(locationTerm) ||
            (normalizedLocationTerm && index.locationsNormalized.includes(normalizedLocationTerm));

        const isVisible = categoryMatch && serviceMatch && locationMatch;
        card.style.display = isVisible ? "" : "none";
        if (isVisible) visibleCount++;
    });

    // Update results summary & reset button visibility
    const summaryEl = document.getElementById("resultsSummary");
    const resetBtn = document.getElementById("resetFiltersBtn");
    const hasActiveFilters = Boolean(searchTerm || locationTerm || selectedCategory !== "all");

    if (resetBtn) {
        resetBtn.style.display = hasActiveFilters ? "inline-flex" : "none";
    }

    if (summaryEl) {
        if (!hasActiveFilters) {
            summaryEl.textContent = `Showing all ${cards.length} service providers`;
        } else {
            const filtersDesc = [];
            if (selectedCategory !== "all") filtersDesc.push(`Category: ${selectedCategory}`);
            if (searchTerm) filtersDesc.push(`"${rawSearch.trim()}"`);
            if (locationTerm) filtersDesc.push(`in ${rawLocation.trim()}`);
            summaryEl.textContent = `Showing ${visibleCount} of ${cards.length} providers (${filtersDesc.join(" • ")})`;
        }
    }

    const noResults = document.getElementById("noResults");
    const noResultsHint = document.getElementById("noResultsHint");
    if (noResults) {
        noResults.style.display = visibleCount > 0 ? "none" : "block";
        if (visibleCount === 0 && noResultsHint) {
            noResultsHint.textContent = locationTerm
                ? `No service providers found in "${rawLocation.trim()}". Try selecting another city/town or resetting filters.`
                : `No providers matched your search. Try another keyword or reset filters.`;
        }
    }
}

function searchProviders() {
    applyProviderFilters();
}

function handleSearchSubmit() {
    closeLocationDropdown();
    showHomePage();
    applyProviderFilters();
    document.getElementById("providers")?.scrollIntoView({ behavior: "smooth" });
}

function quickSearch(term) {
    const input = document.getElementById("searchInput");
    if (input) input.value = term;
    const categorySelect = document.getElementById("categoryFilter");
    if (categorySelect) categorySelect.value = "all";
    showHomePage();
    applyProviderFilters();
    document.getElementById("providers")?.scrollIntoView({ behavior: "smooth" });
}

function selectCategoryFromCard(categoryValue) {
    const input = document.getElementById("searchInput");
    if (input) input.value = "";
    const categorySelect = document.getElementById("categoryFilter");
    if (categorySelect) categorySelect.value = categoryValue;
    showHomePage();
    applyProviderFilters();
    document.getElementById("providers")?.scrollIntoView({ behavior: "smooth" });
}

function filterProviders() {
    applyProviderFilters();
}

function resetAllSearchFilters() {
    const searchInput = document.getElementById("searchInput");
    const locationInput = document.getElementById("locationInput");
    const categoryFilter = document.getElementById("categoryFilter");

    if (searchInput) searchInput.value = "";
    if (locationInput) locationInput.value = "";
    if (categoryFilter) categoryFilter.value = "all";

    renderLocationDropdown("");
    applyProviderFilters();
}

function updateNoResults() {
    const visible = [...document.querySelectorAll(".provider-card")].some(c => c.style.display !== "none");
    const noResults = document.getElementById("noResults");
    if (noResults) noResults.style.display = visible ? "none" : "block";
}

function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
    } catch {
        return [];
    }
}

function toggleFavorite(button) {
    const providerName = button.closest(".provider-card")?.dataset.name;
    if (!providerName) return;

    let favorites = getFavorites();
    if (favorites.includes(providerName)) {
        favorites = favorites.filter(name => name !== providerName);
        button.classList.remove("active");
        button.innerHTML = '<i class="fa-regular fa-heart"></i>';
        showToast("Removed from favorites.");
    } else {
        favorites.push(providerName);
        button.classList.add("active");
        button.innerHTML = '<i class="fa-solid fa-heart"></i>';
        showToast("Added to favorites.");
    }
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

function showFavorites() {
    const favorites = getFavorites();
    if (!favorites.length) return showToast("You have no favorite providers yet.");
    browseProviders();
    document.querySelectorAll(".provider-card").forEach(card => {
        card.style.display = favorites.includes(card.dataset.name) ? "" : "none";
    });
    updateNoResults();
}

function submitContact(event) {
    event.preventDefault();
    event.target.reset();
    showToast("Thank you! Your message has been received.");
}

function formatSchedule(val) {
    if (!val || val === "Flexible") return "Flexible";
    const parsed = new Date(val);
    return isNaN(parsed) ? val : parsed.toLocaleString();
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
}

function escapeAttr(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function showToast(message) {
    const toast = document.getElementById("toast");
    const msgEl = document.getElementById("toastMessage");
    if (!toast || !msgEl) return;
    msgEl.textContent = message;
    toast.classList.add("show");
    clearTimeout(window.profinderToastTimer);
    window.profinderToastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}

/* ================= INITIALIZATION & LIVE SYNC ================= */
window.addEventListener("click", event => {
    if (event.target.classList?.contains("modal")) {
        const lockedAuthModal = document.body.classList.contains("auth-locked") &&
            event.target.id === "loginModal";
        const onboarding = event.target.id === "specialistOnboardModal";
        if (!lockedAuthModal && !onboarding) event.target.style.display = "none";
    }

    const picker = document.getElementById("locationPickerWrapper");
    if (picker && !picker.contains(event.target)) {
        closeLocationDropdown();
    }
});

window.addEventListener("storage", event => {
    if (event.key === BOOKINGS_KEY) {
        const user = getCurrentUser();
        if (user?.role === "Customer") renderCustomerBookings();
        if (user?.role === "Service Provider") renderProviderRequests();
    }
    if (event.key === GENERAL_REVIEWS_KEY || event.key === SPECIALIST_REVIEWS_KEY) {
        syncHomepageProviderCards();
    }
    if (event.key === SPECIALISTS_KEY || event.key === JOINED_SPECIALISTS_KEY || event.key === USERS_KEY) {
        syncHomepageProviderCards();
        applyProviderFilters();
        const modal = document.getElementById("profileModal");
        if (modal && modal.style.display === "flex" && currentProvider) viewProvider(currentProvider);
        refreshOpenSpecialistReviewHeader();
    }
});

window.addEventListener("storage", event => {
    const tab = document.getElementById("ratingsTab");
    if (!tab || tab.style.display === "none") return;
    if (event.key === SPECIALIST_REVIEWS_KEY || event.key === SPECIALISTS_KEY ||
        event.key === JOINED_SPECIALISTS_KEY || event.key === USERS_KEY) {
        renderProviderRatings();
    }
});

document.addEventListener("DOMContentLoaded", () => {
    seedDefaultProviderAccounts();
    renderLocationDropdown("");

    reconcileRenamedProviders();
    getUsers()
        .filter(acc => acc.role === "Service Provider")
        .forEach(publishProviderCard);

    syncHomepageProviderCards();
    applyProviderFilters();

    const favorites = getFavorites();
    document.querySelectorAll(".provider-card").forEach(card => {
        if (favorites.includes(card.dataset.name)) {
            const btn = card.querySelector(".favorite");
            if (btn) {
                btn.classList.add("active");
                btn.innerHTML = '<i class="fa-solid fa-heart"></i>';
            }
        }
    });

    const roleSelect = document.getElementById("registerRole");
    const providerFields = document.getElementById("providerRegisterFields");
    if (roleSelect && providerFields) {
        const updateFields = () => {
            const isProvider = roleSelect.value === "Service Provider";
            providerFields.style.display = isProvider ? "block" : "none";
        };
        roleSelect.addEventListener("change", updateFields);
        updateFields();
    }

    initOtpInputs();
    updateHeroStats();

    document.getElementById("providerStats")?.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const card = event.target.closest(".stat-card");
        if (!card) return;
        event.preventDefault();
        card.click();
    });

    setInterval(() => {
        const dashboard = document.getElementById("providerDashboard");
        if (dashboard && dashboard.style.display !== "none") updateProviderStats();
    }, 4000);

    /* Navbar links also work while a dashboard is open: they bring the Home page back first */
    document.querySelectorAll("#navLinks a").forEach(link => {
        link.addEventListener("click", event => {
            document.getElementById("navLinks")?.classList.remove("active");
            if (!getCurrentUser()) return event.preventDefault();

            const homeHidden = document.getElementById("home").style.display === "none";
            if (homeHidden) {
                event.preventDefault();
                const target = link.getAttribute("href");
                showHomePage();
                setTimeout(() => document.querySelector(target)?.scrollIntoView({ behavior: "smooth" }), 60);
            }
        });
    });

    updateNavAuthButtons();
    const user = getCurrentUser();
    if (user) {
        enterApp(user);
    } else {
        enterAuthGate();
    }
});

/* ======================= FIREBASE LOGIN LAYER ======================= */

/* =========================================================
   PROFINDER - FIREBASE LOGIN LAYER
   Ilagay PAGKATAPOS ng script.js:
       <script src="cloud-sync.js"></script>
       <script src="script.js"></script>
       <script src="firebase-auth.js"></script>

   Pinapalitan lang nito ang ilang function para ang password ay
   hawak na ng Firebase Authentication (hashed, nasa server) at hindi na
   plain text sa localStorage. Ang email OTP step mo ay nananatili.
   Kung hindi pa naka-set ang Firebase keys, wala itong ginagawa.
========================================================= */
(function () {
    if (!window.CloudAuth || !window.CloudSync) {
        console.info("[firebase-auth] Hindi aktibo (walang Firebase keys). Gumagana pa rin ang lumang login.");
        return;
    }

    const lower = v => String(v || "").trim().toLowerCase();

    function saveUserWithoutPassword(user) {
        const clean = { ...user, passwordSet: true };
        delete clean.password;
        const users = getUsers();
        const i = users.findIndex(u => lower(u.email) === lower(clean.email));
        if (i >= 0) users[i] = { ...users[i], ...clean };
        else users.push(clean);
        delete users[i >= 0 ? i : users.length - 1].password;
        saveUsers(users);
        return clean;
    }

    function finishSignIn(user, event, message) {
        setCurrentUser(user);
        closeAllModals();
        if (event && event.target && event.target.reset) event.target.reset();
        resetLoginFlow();
        enterApp(user);
        showToast(message);
        window.CloudSync.syncNow();        // kunin ang bookings/data mula sa cloud at i-upload ang lokal
    }

    /* Hanapin muna sa cloud kung walang lokal na account (login sa bagong device) */
    const originalFindUserByEmail = window.findUserByEmail;
    window.findUserByEmail = function (email) {
        const local = originalFindUserByEmail(email);
        if (local) return local;
        return window.CloudSync.pullProfileSync(email) ? originalFindUserByEmail(email) : null;
    };

    /* "Kailangan pang gumawa ng password" = seeded demo provider na wala pang Firebase account */
    window.accountNeedsPasswordSetup = function (user) {
        if (!user || user.passwordSet) return false;
        return DEFAULT_PROVIDERS.some(p =>
            lower(p.email) === lower(user.email) && p.password === user.password
        );
    };

    /* Create password (first time ng seeded provider account) */
    window.createPassword = async function (event) {
        event.preventDefault();
        const email = loginOtpState.verifiedEmail;
        if (!email) {
            showToast("Please verify your email first.");
            return goToLoginStep("email");
        }

        const password = document.getElementById("newPassword").value;
        const confirm = document.getElementById("confirmNewPassword").value;
        if (password.length < 6) return showToast("Password must be at least 6 characters.");
        if (password !== confirm) return showToast("Passwords do not match. Please retype them.");

        const account = findUserByEmail(email);
        if (!account) {
            document.getElementById("registerEmail").value = email;
            showToast("No account yet for this email. Let's set it up.");
            return goToLoginStep("setup");
        }

        const result = await CloudAuth.signUp(email, password);
        if (!result.ok) {
            if (String(result.error).startsWith("EMAIL_EXISTS")) {
                showToast("This account already has a password. Please log in, or use “Forgot password?”.");
                return goToLoginStep("password");
            }
            return showToast(CloudAuth.explain(result.error));
        }

        CloudAuth.set(result.data);                        // token muna, bago mag-save (para ma-upload)
        const user = saveUserWithoutPassword(account);
        finishSignIn(user, event, "Password saved. Welcome to ProFinder!");
    };

    /* Bagong account (Customer / Service Provider) */
    window.register = async function (event) {
        event.preventDefault();
        const name = document.getElementById("registerName").value.trim();
        const email = document.getElementById("registerEmail").value.trim().toLowerCase();
        if (!email || loginOtpState.verifiedEmail !== email) {
            showToast("Please verify your email first.");
            return goToLoginStep("email");
        }
        const role = document.getElementById("registerRole").value;
        const password = document.getElementById("registerPassword").value;
        const confirmPassword = document.getElementById("registerConfirmPassword").value;

        if (password.length < 6) return showToast("Password must be at least 6 characters.");
        if (password !== confirmPassword) return showToast("Passwords do not match. Please retype them.");

        const result = await CloudAuth.signUp(email, password);
        if (!result.ok) {
            if (String(result.error).startsWith("EMAIL_EXISTS")) {
                showToast("This email already has an account. Continue with your password.");
                return goToLoginStep("password");
            }
            return showToast(CloudAuth.explain(result.error));
        }

        CloudAuth.set(result.data);
        const user = saveUserWithoutPassword({ name, email, phone: "0917-555-0199", role });
        finishSignIn(user, event, "Account created successfully!");
    };

    /* Login gamit ang Firebase */
    window.login = async function (event) {
        event.preventDefault();
        const email = loginOtpState.verifiedEmail;
        if (!email) {
            showToast("Please verify your email first.");
            return goToLoginStep("email");
        }
        const password = document.getElementById("loginPassword").value;

        const account = findUserByEmail(email);
        if (!account) {
            document.getElementById("registerEmail").value = email;
            showToast("No account yet for this email. Let's set it up.");
            return goToLoginStep("setup");
        }
        if (accountNeedsPasswordSetup(account)) return goToLoginStep("newpass");

        let result = await CloudAuth.signIn(email, password);

        // Lumang account (may password sa localStorage): ilipat sa Firebase isang beses
        if (!result.ok && CloudAuth.isBadCredentials(result.error) && account.password && account.password === password) {
            const upgraded = await CloudAuth.signUp(email, password);
            if (upgraded.ok) result = upgraded;
        }

        if (!result.ok) {
            const field = document.getElementById("loginPassword");
            field.value = "";
            field.focus();
            return showToast(CloudAuth.explain(result.error));
        }

        CloudAuth.set(result.data);
        const user = saveUserWithoutPassword(account);
        finishSignIn(user, event, "Login successful!");
    };

    /* Forgot password: Firebase mismo ang magpapadala ng reset link */
    window.startPasswordReset = async function () {
        const email = loginOtpState.verifiedEmail;
        if (!email) return goToLoginStep("email");

        const result = await CloudAuth.sendReset(email);
        if (result.ok) {
            return showToast(`We sent a password reset link to ${email}. Open it, set a new password, then log in here.`);
        }
        if (String(result.error).startsWith("EMAIL_NOT_FOUND")) {
            return showToast("No cloud password yet. Log in once with your old password to upgrade this account.");
        }
        showToast(CloudAuth.explain(result.error));
    };

    /* Logout: kasama ang pagtanggal ng token */
    const originalLogout = window.logout;
    window.logout = function () {
        CloudAuth.clear();
        originalLogout();
    };

    /* Kung naka-login na ang session pagbukas ng page, i-sync agad */
    if (CloudAuth.isSignedIn()) window.CloudSync.syncNow();
})();