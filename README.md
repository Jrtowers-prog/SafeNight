# 🌙 SafeNight

A cross-platform mobile app that helps pedestrians find **safer walking routes at night** by building a custom OSM walking graph, running **A\* pathfinding with a multi-factor safety cost function**, and visualising risk per segment on an interactive map — with **AI-powered route explanations** via GPT-4o-mini.

Built with **React Native (Expo SDK 54)**, **TypeScript**, and a **5-microservice Express.js backend** (API Gateway, Safety Compute, User Data, Subscription, Geocode) deployed on **Render.com**, with **Supabase** (Postgres + Auth) and **Stripe** payments.

**Version**: 1.0.13 · **Platforms**: Android (Google Play), Web (Netlify), iOS (coming soon)

---

## ✨ Features

### 🗺️ Routing & Safety

| Feature                          | Description                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Graph-based safe routing**     | Builds a full OSM walking graph from Overpass data and runs A\* pathfinding with a safety-weighted cost function to find 3–5 optimally safe route alternatives.                                   |
| **6-factor safety scoring**      | Every graph edge is scored on **crime density, street lighting, CCTV coverage, road type, open businesses, and foot traffic** — with time-adaptive weights that shift for late night vs. daytime. |
| **Colour-coded segments**        | Routes are split into ~50 m chunks and rendered green / yellow / red on the map so risk hotspots are visible at a glance.                                                                         |
| **Safety panel & profile chart** | Detailed breakdown of per-factor scores with a visual safety profile chart.                                                                                                                       |
| **Dead-end detection**           | Nodes with degree ≤ 1 receive a safety penalty. Dead ends are flagged to users.                                                                                                                   |
| **K-diverse routes**             | After finding the safest route, penalises used edges by +0.15 and re-runs A\*; filters duplicates by >85% edge overlap.                                                                           |
| **Crime severity weighting**     | Not all crimes are equal — violent crime/robbery = 1.0, shoplifting = 0.2.                                                                                                                        |

### 🧭 Navigation

| Feature                     | Description                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Turn-by-turn navigation** | Full walking navigation with live GPS tracking, off-route detection (>100 m), arrival detection (40 m), and step-by-step instructions. |
| **Compass heading**         | Real compass via magnetometer (EMA-smoothed), with GPS heading fallback.                                                               |
| **Roundabout detection**    | Short segment groups with ≥3 segments and >120° total bearing change → "At the roundabout" instruction.                                |
| **Road name merging**       | Consecutive segments on the same road are merged. Short unnamed junctions are absorbed.                                                |

### 🤖 AI Features

| Feature                   | Description                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI safety explanation** | GPT-4o-mini generates a plain-English summary explaining _why_ the safest route was chosen, referencing specific safety metrics (crime counts, lit roads, CCTV, etc.). |
| **Client-side caching**   | AI explanations are cached per route combination — repeat requests return instantly.                                                                                   |

### 👤 User Accounts & Auth

| Feature                           | Description                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ |
| **Passwordless magic link login** | Email → 6-digit OTP code → verify. No passwords.                               |
| **Session management**            | Access + refresh tokens with proactive refresh 2 min before expiry.            |
| **Username system**               | Unique usernames (3–20 chars) for QR code pairing in the Safety Circle.        |
| **Profile sync**                  | Tracks app version + platform on every login.                                  |
| **Account deletion**              | Full GDPR-compliant permanent deletion (Google Play compliance).               |
| **Foreground revalidation**       | Revalidates session on app foreground (native) or tab visibility change (web). |

### 🛡️ Safety Circle (Buddy System)

| Feature                     | Description                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| **QR code pairing**         | User's QR code contains `safenight://username`. Friends scan it to send a contact request. |
| **Contact requests**        | Invite → accept / reject / block flow with pending request list.                           |
| **Emergency contacts list** | Shows all accepted contacts with live status indicator.                                    |
| **Live status indicators**  | Green pulse animation when a contact is actively walking.                                  |

### 📍 Live Location Sharing

| Feature                   | Description                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live sessions**         | Automatically starts a live tracking session when navigation begins. Shares current location, destination, and planned route path with Safety Circle contacts. |
| **Real-time updates**     | GPS position sent to server every 5 seconds.                                                                                                                   |
| **Heartbeat**             | Server heartbeat every 15 seconds to keep session marked alive (even if stationary).                                                                           |
| **Breadcrumb trail**      | Contact's actual GPS path shown on the map. Deduplicated to ~1 m precision.                                                                                    |
| **Planned route display** | Contact's planned route polyline is shared at session start and visible to watchers.                                                                           |
| **Background location**   | Google Play-compliant: prominent disclosure modal before system permission prompt.                                                                             |
| **Push notifications**    | Expo push notifications registered on login. Android notification channel configured.                                                                          |

### 🚨 User-Generated Reports

| Feature                    | Description                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Two-step report flow**   | Step 1: "Hazard" or "Safety Data". Step 2: Pick category + follow-up questions + optional description. |
| **Hazard categories**      | Poor Lighting, Unsafe Area, Obstruction, Harassment, Suspicious Activity, Dead End, Other.             |
| **Safety data categories** | CCTV Camera, Street Light, Bus Stop, Safe Space/Shop.                                                  |
| **CCTV detail capture**    | Type (dome/shop/police/residential/traffic), coverage, height, compass direction.                      |
| **Nearby reports**         | Fetch reports within a radius for proximity-based display.                                             |

### 💳 Subscription & Monetisation

| Feature                       | Description                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Stripe checkout**           | Opens browser for payment (mobile via deep link, web via popup).                                                  |
| **Customer portal**           | Stripe portal for managing/cancelling existing subscriptions.                                                     |
| **14-day cooling-off refund** | First subscription within 14 days → full refund. After → active until period end.                                 |
| **Gift subscriptions**        | Admin-granted Pro tier with an expiry date for early adopters.                                                    |
| **Family & Friends Pack**     | Min. 3 members, £3/user/month (save £1.99 vs individual). Owner manages members, invites, checkout, cancellation. |
| **Feature gating**            | All features checked against subscription limits before execution. Global modal for blocked features.             |
| **Usage tracking**            | Events: `app_open`, `route_search`, `navigation_start/complete/abandon`. Aggregated stats available.              |

### 🔍 Place Search & Saved Places

| Feature                    | Description                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| **Nominatim autocomplete** | Place search with in-process TTL cache via dedicated Geocode microservice.      |
| **Pin-drop routing**       | Long-press to set origin/destination directly on the map.                       |
| **Saved places**           | Local storage for Home, Work, Gym, School + custom labels. Duplicate detection. |

### 📱 Platform & UX

| Feature                    | Description                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Cross-platform maps**    | Leaflet (via WebView) on Android, `react-native-maps` on iOS, Leaflet on web.                  |
| **3-step welcome wizard**  | Name + Username → Location Permission → Buddy System intro.                                    |
| **Animated splash screen** | Custom splash with animated pathfinding visualisation.                                         |
| **Force update screen**    | Full-screen blocker when a mandatory update is required.                                       |
| **OTA auto-updates**       | Checks for Expo Updates on launch + every 30 min. Downloads and reloads automatically.         |
| **Web download prompt**    | When a web user tries to start navigation, a modal offers the Android APK download.            |
| **Reviews system**         | User ratings + comments (submit, update, delete). Public reviews with average + count summary. |

### ⚡ Performance

| Feature                      | Description                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Spatial indexing**         | Grid-based spatial indices (~100 m cells) for O(1) proximity lookups, replacing brute-force distance checks.                 |
| **Coverage maps**            | Pre-computed `Float32Array` grids with inverse-distance-squared falloff for lighting and crime density.                      |
| **Multi-layer caching**      | Route cache (5 min), OSM data cache (30 min), crime data cache (24 h), request coalescing for concurrent identical requests. |
| **Combined Overpass query**  | Consolidates 4 separate queries into 1 — ~70% latency reduction.                                                             |
| **Overpass server rotation** | Rotates between 3 Overpass servers with automatic retry on 429/5xx.                                                          |

### 📜 Legal & Compliance

| Feature                            | Description                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| **Privacy Policy**                 | Full privacy policy page.                                         |
| **Terms & Conditions**             | Full T&C page.                                                    |
| **Refund Policy**                  | Full refund policy page.                                          |
| **Account Deletion**               | GDPR / Google Play compliant deletion page.                       |
| **Background Location Disclosure** | Google Play-compliant prominent disclosure modal.                 |
| **Web SEO**                        | `manifest.json`, `robots.txt`, `sitemap.xml`, OpenGraph metadata. |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Mobile App (Expo SDK 54)                    │
│                                                              │
│  app/              Expo Router screens                       │
│    _layout.tsx     Root layout + auth gate + welcome wizard  │
│    index.tsx       Main screen (map, search, routes, nav)    │
│    privacy.tsx     Privacy policy                            │
│    terms.tsx       Terms & conditions                        │
│    refund.tsx      Refund policy                             │
│    delete-account  GDPR account deletion                     │
│                                                              │
│  src/                                                        │
│  ├── components/                                             │
│  │   ├── maps/         Platform-specific map views           │
│  │   ├── android/      Android WebView overlay z-ordering    │
│  │   ├── modals/       AI, onboarding, buddy, subscription,  │
│  │   │                 login, report, family pack, download   │
│  │   ├── navigation/   Turn-by-turn overlay                  │
│  │   ├── routes/       Route list & route cards              │
│  │   ├── safety/       Safety panel & profile chart          │
│  │   ├── search/       Search bar with autocomplete          │
│  │   ├── seo/          Web SEO (PageHead, meta tags)         │
│  │   ├── sheets/       Draggable bottom sheet, web sidebar   │
│  │   └── ui/           Profile menu, buddy button, toasts,   │
│  │                     force update, loading, download banner │
│  ├── config/           Env vars, SEO config                  │
│  ├── hooks/            21 custom React hooks                 │
│  ├── services/         API clients, scoring logic, Stripe    │
│  ├── types/            TypeScript type definitions           │
│  └── utils/            Polyline, caching, spatial utils      │
└─────────────┬────────────────────────────────────────────────┘
              │  HTTPS
              ▼
┌────────────────────────────────────────────────────────────────┐
│         Service 1 — API Gateway (port 3001)                    │
│         Lightweight I/O proxy — proxies external APIs          │
│         Rate limit: 100 req/15 min/IP                          │
│                                                                │
│  GET  /api/directions          OSRM walking directions         │
│  GET  /api/nearby              Nearby amenities (Overpass)     │
│  POST /api/explain-route       AI explanation (OpenAI proxy)   │
│  GET  /api/staticmap           Static map images               │
│  POST /api/integrity/verify    Google Play app integrity       │
│  GET  /api/health              Health check                    │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│         Service 2 — Safety Compute (port 3002)                 │
│         CPU-heavy A* pathfinding + safety scoring              │
│         Rate limit: 60 req/15 min/IP                           │
│                                                                │
│  GET  /api/safe-routes         A* pathfinding + safety scores  │
│  GET  /api/health              Health check                    │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│         Service 3 — User Data (port 3003)                      │
│         Auth, profiles, contacts, live tracking, reports,      │
│         reviews, usage, family packs                           │
│         DB: Supabase (Postgres + Auth)                         │
│                                                                │
│  POST /api/auth/magic-link     Send OTP email                  │
│  POST /api/auth/verify         Verify OTP → tokens             │
│  GET  /api/auth/me             Get profile                     │
│  POST /api/auth/update-profile Update name/username            │
│  POST /api/auth/accept-disclaimer  Accept safety disclaimer    │
│  POST /api/auth/logout         Logout + clear tokens           │
│  POST /api/auth/refresh        Refresh access token            │
│  DELETE /api/auth/account      GDPR account deletion           │
│                                                                │
│  POST /api/contacts/username   Set username for QR pairing     │
│  GET  /api/contacts/lookup/:u  Lookup user by username         │
│  POST /api/contacts/invite     Send contact request            │
│  POST /api/contacts/respond    Accept/reject/block             │
│  GET  /api/contacts            List contacts                   │
│  GET  /api/contacts/pending    Pending requests                │
│  DELETE /api/contacts/:id      Remove contact                  │
│                                                                │
│  POST /api/live/start          Start live tracking session     │
│  POST /api/live/update         Update GPS location             │
│  POST /api/live/end            End session                     │
│  GET  /api/live/my-session     Get active session              │
│  GET  /api/live/watch/:userId  Watch a contact's location      │
│  POST /api/live/heartbeat      Keep session alive              │
│                                                                │
│  POST /api/reports             Submit hazard/safety report     │
│  GET  /api/reports             All reports (public)            │
│  GET  /api/reports/nearby      Reports within radius           │
│  GET  /api/reports/mine        User's own reports              │
│  DELETE /api/reports/:id       Delete own report               │
│                                                                │
│  POST /api/reviews             Submit review                   │
│  GET  /api/reviews             All reviews (public)            │
│  GET  /api/reviews/summary     Average rating + count          │
│  PUT  /api/reviews/:id         Update own review               │
│  DELETE /api/reviews/:id       Delete own review               │
│                                                                │
│  POST /api/usage/track         Track usage event               │
│  GET  /api/usage/stats         Aggregated stats                │
│  GET  /api/subscriptions/check/:feature  Check feature limit   │
│                                                                │
│  POST /api/family/create       Create family pack              │
│  GET  /api/family/my-pack      Get pack details                │
│  POST /api/family/add-member   Add member                      │
│  POST /api/family/remove-member Remove member                  │
│  POST /api/family/activate     Activate membership             │
│  POST /api/family/cancel       Cancel pack                     │
│  POST /api/family/update-member-email  Update email            │
│  POST /api/family/resend-invite Resend invite email            │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│         Service 4 — Subscription (port 3004)                   │
│         Stripe payment processing                              │
│         Rate limit: 30 req/15 min/user                         │
│                                                                │
│  GET  /api/stripe/plans                Available plans         │
│  POST /api/stripe/create-checkout      Individual checkout     │
│  POST /api/stripe/create-family-checkout Family checkout       │
│  POST /api/stripe/create-portal        Customer portal         │
│  GET  /api/stripe/status               Subscription status     │
│  POST /api/stripe/cancel               Cancel subscription     │
│  POST /api/stripe/webhook              Stripe webhook          │
│  GET  /api/health                      Health check            │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│         Service 5 — Geocode (port 3005)                        │
│         Place search & geocoding with Nominatim + TTL cache    │
│         Rate limit: 200 req/15 min/IP                          │
│                                                                │
│  GET  /api/places/autocomplete   Search places                 │
│  GET  /api/places/details        Place details                 │
│  GET  /api/places/reverse        Reverse geocoding             │
│  GET  /api/health                Health check                  │
└────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    External Data Sources                      │
│                                                              │
│  • Overpass API — roads, street lights, CCTV, transit, shops │
│  • UK Police API — street-level crime data (England & Wales) │
│  • OSRM — pedestrian walking directions                      │
│  • Nominatim — place search & reverse geocoding              │
│  • OpenAI API — GPT-4o-mini for route explanations           │
│  • OpenStreetMap Tiles — raster map tiles                    │
│  • Stripe — payment processing                              │
│  • Supabase — Postgres DB + Auth (magic link)                │
│  • Resend — transactional email (family pack invites)        │
│  • Expo Push Notifications — push delivery                   │
└──────────────────────────────────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **npm** or **yarn**
- **Expo CLI** (`npx expo`)
- For Android: Android Studio with an emulator or a physical device
- For iOS: Xcode with a simulator (macOS only)

### 1. Clone & install

```bash
git clone https://github.com/Jrtowers-prog/PlymHack2026New.git
cd PlymHack2026New
npm install
cd backend && npm install && cd ..
```

### 2. Configure environment variables

**Frontend** — create `.env` in the project root:

```env
# ─── Required ───────────────────────────────────────
EXPO_PUBLIC_API_BASE_URL=http://localhost:3001      # API Gateway URL
EXPO_PUBLIC_SAFETY_API_URL=http://localhost:3002    # Safety Compute Service URL
EXPO_PUBLIC_USER_API_URL=http://localhost:3003      # User Data Service URL
EXPO_PUBLIC_SUBSCRIPTION_API_URL=http://localhost:3004  # Subscription Service URL
EXPO_PUBLIC_GEOCODE_API_URL=http://localhost:3005   # Geocode Service URL

# ─── Recommended ────────────────────────────────────
EXPO_PUBLIC_OSM_USER_AGENT=        # Descriptive user-agent for Nominatim (required in prod)
EXPO_PUBLIC_OSM_EMAIL=             # Contact email for Nominatim

# ─── Optional (sensible defaults provided) ──────────
EXPO_PUBLIC_OS_MAPS_API_KEY=       # Ordnance Survey Maps API key
EXPO_PUBLIC_OS_MAPS_LAYER=Road_3857
EXPO_PUBLIC_OS_MAPS_BASE_URL=https://api.os.uk/maps/raster/v1/zxy
EXPO_PUBLIC_OSM_BASE_URL=https://nominatim.openstreetmap.org
EXPO_PUBLIC_OSM_TILE_URL=https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}
EXPO_PUBLIC_OSRM_BASE_URL=https://router.project-osrm.org
EXPO_PUBLIC_OVERPASS_API_URL=https://overpass-api.de/api/interpreter
EXPO_PUBLIC_POLICE_API_URL=https://data.police.uk/api
```

**Backend** — create `.env` in `backend/`:

```env
PORT=3001
OPENAI_API_KEY=your-openai-key           # Required for AI explanations
SUPABASE_URL=your-supabase-url           # Required for auth & database
SUPABASE_SERVICE_ROLE_KEY=your-key       # Required for server-side Supabase access
STRIPE_SECRET_KEY=your-stripe-key        # Required for subscriptions
STRIPE_WEBHOOK_SECRET=your-webhook-secret # Required for Stripe webhook verification
RESEND_API_KEY=your-resend-key           # Required for family pack invite emails
ALLOWED_ORIGINS=http://localhost:8081,http://localhost:19006
OSM_USER_AGENT=SafeNightHome/1.0
NODE_ENV=development
```

### 3. Start the backend

```bash
cd backend
npm run dev          # Starts all 5 services (Gateway 3001, Safety 3002, User 3003, Subscription 3004, Geocode 3005)
```

### 4. Run the app

```bash
# In a separate terminal, from project root:
npx expo start

# Platform-specific shortcuts
npx expo start --web        # Open in browser
npx expo run:android        # Build & run on Android
npx expo run:ios            # Build & run on iOS
```

---

## 📂 Project Structure

```
PlymHack2026New/
├── app/                              Expo Router screens
│   ├── _layout.tsx                   Root layout + auth gate + welcome wizard
│   ├── index.tsx                     Main screen (map, search, routes, nav)
│   ├── modal.tsx                     Modal route
│   ├── privacy.tsx                   Privacy policy page
│   ├── terms.tsx                     Terms & conditions page
│   ├── refund.tsx                    Refund policy page
│   └── delete-account.tsx            GDPR account deletion page
│
├── src/
│   ├── components/
│   │   ├── android/                  Android WebView overlay z-ordering
│   │   ├── maps/                     Platform-specific map implementations
│   │   │   ├── RouteMap.tsx          Platform switch
│   │   │   ├── RouteMap.android.tsx  Android (Leaflet via WebView)
│   │   │   ├── RouteMap.native.tsx   iOS (react-native-maps)
│   │   │   ├── RouteMap.web.tsx      Web (Leaflet)
│   │   │   ├── leafletMapHtml.ts     Leaflet HTML injection
│   │   │   └── mapConstants.ts       Shared map config
│   │   ├── modals/                   All modal dialogs
│   │   │   ├── AIExplanationModal    AI route explanation
│   │   │   ├── BackgroundLocationModal  Android background location disclosure
│   │   │   ├── BuddyModal           Safety Circle contacts manager
│   │   │   ├── DisclaimerModal       Safety disclaimer
│   │   │   ├── DownloadAppModal      Web → native app download
│   │   │   ├── FamilyPackModal       Family & Friends pack management
│   │   │   ├── LimitReachedModal     Subscription limit hit
│   │   │   ├── LoginModal            Passwordless magic-link login
│   │   │   ├── OnboardingModal       First-launch onboarding
│   │   │   ├── PrivacyPolicyModal    Privacy policy
│   │   │   ├── RefundPolicyModal     Refund policy
│   │   │   ├── ReportModal           Hazard & safety data reporting
│   │   │   ├── SubscriptionModal     Subscription plans & checkout
│   │   │   ├── TermsModal            Terms & conditions
│   │   │   └── WelcomeModal          3-step welcome wizard
│   │   ├── navigation/              Turn-by-turn overlay
│   │   ├── routes/                   Route list & route cards
│   │   ├── safety/                   Safety panel & profile chart
│   │   ├── search/                   Search bar with autocomplete
│   │   ├── seo/                      Web SEO components (PageHead)
│   │   ├── sheets/                   Draggable bottom sheet, web sidebar
│   │   └── ui/                       Profile menu, buddy button, toasts,
│   │                                 force update, loading, download banner
│   │
│   ├── config/
│   │   ├── env.ts                    Centralised env-var access
│   │   └── seo.ts                    SEO configuration
│   │
│   ├── hooks/
│   │   ├── useAIExplanation.ts       Triggers OpenAI route explanation
│   │   ├── useAllRoutesSafety.ts     Parallel safety scoring for all routes
│   │   ├── useAuth.ts                Passwordless auth + session management
│   │   ├── useAutoPlaceSearch.ts     Automatic place search on input
│   │   ├── useAutoUpdate.ts          OTA update checks (every 30 min)
│   │   ├── useContacts.ts            Safety Circle contacts + requests
│   │   ├── useCurrentLocation.ts     GPS location + permission handling
│   │   ├── useDirections.ts          Fetches OSRM walking directions
│   │   ├── useFriendLocations.ts     Poll friends' live locations
│   │   ├── useHomeScreen.ts          Main screen orchestration
│   │   ├── useLiveTracking.ts        Live location sharing sessions
│   │   ├── useNavigation.ts          Turn-by-turn navigation state
│   │   ├── useOnboarding.ts          Onboarding/disclaimer persistence
│   │   ├── usePlaceAutocomplete.ts   Place autocomplete
│   │   ├── useRouteSafety.ts         Full safety map data for selected route
│   │   ├── useSafeRoutes.ts          Backend safe-routes integration
│   │   ├── useSavedPlaces.ts         Saved places (Home, Work, custom)
│   │   ├── useSegmentSafety.ts       Per-segment scoring for a route
│   │   ├── useUpdateCheck.ts         GitHub Releases auto-update check
│   │   ├── useUsageTracker.ts        Usage event tracking
│   │   └── useWebBreakpoint.ts       Responsive web breakpoints
│   │
│   ├── services/
│   │   ├── googleMaps.ts             Google Maps REST client
│   │   ├── location.ts              expo-location wrapper
│   │   ├── onboarding.ts            AsyncStorage persistence
│   │   ├── openai.ts                OpenAI client (backend proxy)
│   │   ├── openStreetMap.ts         Nominatim + OSRM client
│   │   ├── osMaps.ts               OS Maps tile URL builder
│   │   ├── osmDirections.ts        OSM directions service
│   │   ├── playIntegrity.ts        Google Play integrity verification
│   │   ├── routeSegmentEnricher.ts  Spatial-grid segment enrichment
│   │   ├── safeRoutes.ts           Safe routes client + caching
│   │   ├── safety.ts               Core safety pipeline
│   │   ├── safetyMapData.ts        Map-oriented safety data aggregator
│   │   ├── segmentScoring.ts       Weighted segment risk scoring
│   │   ├── stripeApi.ts            Stripe subscription client
│   │   └── userApi.ts              User/auth/contacts/live API client
│   │
│   ├── types/
│   │   ├── errors.ts               AppError class with error codes
│   │   ├── google.ts               Core domain types (LatLng, Route, etc.)
│   │   ├── limitError.ts           Subscription limit event types
│   │   ├── osm.ts                  Nominatim & OSRM response types
│   │   └── safety.ts              Safety analysis pipeline types
│   │
│   └── utils/
│       ├── colorCode.ts            Score → colour/risk-level mapping
│       ├── format.ts               Formatting utilities
│       ├── lightingScore.ts        Lighting score from OSM tags + time
│       ├── nearbyCache.ts          Nearby-places cache
│       ├── overpassQueue.ts        Overpass request queue
│       ├── polyline.ts             Google polyline encode/decode
│       └── segmentRoute.ts         Route → 50 m segment splitter
│
├── backend/
│   ├── package.json                 Backend dependencies & scripts
│   └── src/
│       ├── shared/                  Code shared between all services
│       │   ├── types/               JSDoc type definitions
│       │   ├── middleware/          CORS, rate limiter, error handler, health
│       │   └── validation/          Input validation
│       ├── gateway/                 Service 1 — API Gateway (port 3001)
│       │   ├── server.js            Gateway entry point
│       │   └── routes/              directions, nearby, explain, staticmap,
│       │                            integrity
│       ├── safety/                  Service 2 — Safety Compute (port 3002)
│       │   ├── server.js            Safety entry point
│       │   ├── routes/              safeRoutes
│       │   └── services/            crimeClient, overpassClient, safetyGraph,
│       │                            geo
│       ├── user/                    Service 3 — User Data (port 3003)
│       │   ├── server.js            User entry point
│       │   ├── routes/              auth, contacts, live, reports, reviews,
│       │   │                        usage, subscriptions, family
│       │   └── migrations/          Supabase SQL migrations
│       ├── subscription/            Service 4 — Subscription (port 3004)
│       │   ├── server.js            Subscription entry point
│       │   └── routes/              stripe (checkout, portal, webhook,
│       │                            plans, cancel)
│       └── geocode/                 Service 5 — Geocode (port 3005)
│           ├── server.js            Geocode entry point
│           └── routes/              places (autocomplete, details, reverse)
│
├── .github/workflows/                CI/CD pipelines
│   ├── build-android.yml              Auto-build APK on push to main
│   └── build-ios.yml                  iOS IPA build (manual trigger)
├── android/                         Android native project
├── ios/                             iOS native project
├── public/                          Web static assets (manifest, robots, sitemap, OG image)
├── assets/images/                   Static image assets
├── app.json                         Expo app config
├── app.config.js                    Expo config (permissions, plugins)
├── eas.json                         EAS Build profiles
├── render.yaml                      Render.com backend deployment
├── netlify.toml                     Netlify web frontend deployment
├── package.json                     Frontend dependencies
└── tsconfig.json                    TypeScript configuration
```

---

## 🧠 Key Algorithms

### A\* Pathfinding with Safety Weighting

The backend builds a **full OSM walking graph** from Overpass data, then runs a custom A\* search:

1. **Graph construction** — indexes all OSM nodes, filters 14 walkable highway types, builds bidirectional adjacency lists
2. **Edge scoring** — every edge is scored on 6 safety factors using pre-computed coverage maps
3. **Cost function** — `cost = distance / safetyScore` — optimises for short AND safe
4. **Heuristic** — Haversine distance (admissible, never overestimates)
5. **K-diverse routes** — finds safest route, penalises used edges by +0.15, re-runs A\*; filters duplicates by >85% edge overlap
6. **Dead-end detection** — nodes with degree ≤ 1 receive a safety penalty (harder to escape danger)

### Spatial Indexing

Grid-based spatial indices (~100 m cells) provide **O(1) proximity lookups** for nearby features (lights, CCTV, businesses), replacing O(n×m) brute-force distance checks with 9-cell neighbourhood queries.

### Coverage Maps

Pre-computed `Float32Array` grids (~25 m cells) for:

- **Lighting** — inverse-distance-squared falloff from each street lamp (60 m effective radius), with lamp quality multipliers (LED = 1.4×, mercury/gas = 0.7×)
- **Crime density** — severity-weighted with distance decay: $\text{impact} = \frac{\text{severity}}{1 + (d/30)^{1.5}}$

---

## 🧮 Safety Scoring Model

### Per-Edge Scoring (Backend)

$$\text{safetyScore} = \sum_{i} w_i \times \text{factor}_i - \text{surfacePenalty}$$

**Time-adaptive weights** shift based on hour of day:

| Factor       | Late Night (0–5 am) | Evening (6 pm–midnight) | Daytime |
| ------------ | ------------------- | ----------------------- | ------- |
| Road Type    | 0.22                | 0.23                    | 0.25    |
| Lighting     | **0.28**            | 0.25                    | 0.15    |
| Crime        | **0.25**            | 0.22                    | 0.20    |
| CCTV         | 0.08                | 0.07                    | 0.05    |
| Open Places  | 0.07                | 0.12                    | 0.15    |
| Foot Traffic | 0.10                | 0.11                    | 0.20    |

### Crime Severity Weighting

Not all crimes are equal — violent crime/robbery = 1.0, shoplifting = 0.2.

### Per-Segment Scoring (Frontend)

Each route is split into ~50 m segments. Every segment is scored on a **0–1 risk scale**:

$$\text{risk}_{\text{segment}} = w_{\text{crime}} \times \text{crimeRisk} + w_{\text{light}} \times \text{lightingRisk} + w_{\text{road}} \times \text{roadRisk} + w_{\text{activity}} \times \text{activityRisk}$$

| Factor                | Weight | Source        | Description                                                |
| --------------------- | ------ | ------------- | ---------------------------------------------------------- |
| **Crime**             | 30 %   | UK Police API | Recent crime incidents within ~50 m, severity-weighted     |
| **Lighting**          | 22 %   | Overpass API  | Street lamp density, lamp quality, `lit` tags, time-of-day |
| **Road type**         | 15 %   | Overpass API  | Main roads score safer than footpaths/alleys               |
| **Activity**          | 13 %   | Overpass API  | Open shops and cafés nearby (reduces risk)                 |
| **Bus stops**         | 10 %   | Overpass API  | Transit proximity                                          |
| **Road lit fraction** | 10 %   | Overpass API  | Fraction of road tagged as lit                             |

### Route Aggregation

$$\text{risk}_{\text{route}} = \frac{\sum (\text{risk}_i \times \text{length}_i)}{\sum \text{length}_i}$$

$$\text{Safety Score} = (1 - \text{risk}_{\text{route}}) \times 100$$

### Colour Coding

| Colour    | Risk Range | Label       |
| --------- | ---------- | ----------- |
| 🟢 Green  | < 0.3      | Safer       |
| 🟡 Yellow | 0.3 – 0.6  | Caution     |
| 🔴 Red    | > 0.6      | Higher risk |

---

## 🤖 AI Integration

- **Model**: GPT-4o-mini via OpenAI Chat Completions API
- **Architecture**: Frontend sends route data → backend constructs a structured prompt with concrete safety metrics → calls OpenAI → returns ≤150-word explanation
- **Prompt engineering**: Includes per-route safety scores, crime counts, lit/unlit roads, bus stops, open places, main-road ratios. Instructs the model to reference specific numbers and avoid generic safety tips.
- **Security**: OpenAI API key is **server-side only** — the frontend only sends data to the backend proxy
- **Parameters**: `temperature: 0.3`, `max_tokens: 200`

---

## ⚡ Performance Optimisations

| Technique                       | Description                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Multi-layer caching**         | Route cache (5 min TTL), OSM data cache (30 min), crime data cache (24 h), frontend in-memory caches |
| **Request coalescing**          | Concurrent identical safe-route requests share a single computation via in-flight promise maps       |
| **Combined Overpass query**     | Consolidates 4 separate queries (roads, lights, places, transit) into 1 — ~70% latency reduction     |
| **Overpass server rotation**    | Rotates between 3 Overpass servers with automatic retry on 429/5xx                                   |
| **Fast distance approximation** | Equirectangular approximation (5× faster than Haversine) for <5 km proximity checks                  |
| **Rate limiting**               | Express: 100 req/15 min/IP; Overpass queue; Nominatim 300 ms throttle                                |
| **Spatial indexing**            | Grid-based O(1) lookups instead of O(n×m) brute-force                                                |

---

## 🔌 External APIs & Data Sources

| Service                                                              | Purpose                                                               | Auth                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------- |
| [Overpass API](https://overpass-api.de/)                             | OSM road network, street lights, CCTV, transit stops, open businesses | None                  |
| [UK Police API](https://data.police.uk/docs/)                        | Street-level crime data for England & Wales                           | None                  |
| [OSRM](https://project-osrm.org/)                                    | Pedestrian walking directions (fallback + alternatives)               | None                  |
| [Nominatim](https://nominatim.openstreetmap.org/)                    | Place search, autocomplete, reverse geocoding                         | User-Agent            |
| [OpenAI API](https://platform.openai.com/)                           | GPT-4o-mini for natural-language safety explanations                  | API key (server-side) |
| [OpenStreetMap Tiles](https://tile.openstreetmap.org/)               | Raster map tiles                                                      | None                  |
| [Supabase](https://supabase.com/)                                    | Postgres database + Auth (magic link OTP)                             | Service role key      |
| [Stripe](https://stripe.com/)                                        | Payment processing, subscription billing, customer portal             | Secret key + webhook  |
| [Resend](https://resend.com/)                                        | Transactional email (family pack invites)                             | API key               |
| [Expo Push Notifications](https://docs.expo.dev/push-notifications/) | Push notification delivery to mobile devices                          | None (Expo project)   |

---

## 💰 Subscription Tiers

|                           | **Free** | **Guarded** (£4.99/mo) | **Family Pack** (£3/user/mo) |
| ------------------------- | -------- | ---------------------- | ---------------------------- |
| Route searches            | Limited  | Unlimited              | Unlimited                    |
| Route distance            | 1 km max | ~6 miles (~9.6 km)     | ~6 miles (~9.6 km)           |
| Navigation sessions       | Limited  | Unlimited              | Unlimited                    |
| Emergency contacts        | Limited  | 5                      | 5                            |
| AI explanations           | Limited  | 10/day                 | 10/day                       |
| Live location sharing     | Limited  | Unlimited              | Unlimited                    |
| **Minimum members**       | —        | —                      | 3 (including owner)          |
| **Savings vs individual** | —        | —                      | £1.99/person                 |
| **14-day refund**         | —        | ✅                     | ✅                           |

---

## 🚢 Deployment

### Backend → Render.com (5-service split)

| Service            | Port | Entry point                  | Purpose                                                                  |
| ------------------ | ---- | ---------------------------- | ------------------------------------------------------------------------ |
| **API Gateway**    | 3001 | `src/gateway/server.js`      | Lightweight I/O proxy (directions, nearby, AI, static maps, integrity)   |
| **Safety Service** | 3002 | `src/safety/server.js`       | CPU-heavy A\* pathfinding + safety scoring                               |
| **User Data**      | 3003 | `src/user/server.js`         | Auth, profiles, contacts, live tracking, reports, reviews, usage, family |
| **Subscription**   | 3004 | `src/subscription/server.js` | Stripe checkout, portal, webhook, billing                                |
| **Geocode**        | 3005 | `src/geocode/server.js`      | Nominatim place search + reverse geocoding with TTL cache                |

- **Region**: `eu-west` (close to UK users)
- **Plan**: Free tier (512 MB RAM, 0.1 CPU each)
- **Health check**: `/api/health` on all services
- **Database**: Supabase Postgres (500 MB free tier)
- **Config**: See `render.yaml`

### Web Frontend → Netlify

- **Build**: `npx expo export --platform web`
- **Publish directory**: `dist/`
- **SPA**: `/* → /index.html` redirect
- **Config**: See `netlify.toml`

### Native Builds & Distribution

**Android (Google Play + GitHub Releases):**

- **Google Play**: Production builds via EAS Build (`eas build --platform android --profile production`) generate an `.aab` (app bundle) for Play Store submission via `eas submit`
- **GitHub Releases**: A GitHub Actions workflow (`.github/workflows/build-android.yml`) builds a release APK on every push to `main` and uploads it to GitHub Releases
- **OTA Updates**: Expo Updates (runtime version `1.0.2`) — checks on launch + every 30 min, auto-downloads and reloads
- Download link: https://github.com/Jrtowers-prog/PlymHack2026New/releases/download/latest/SafeNightHome.apk

**iOS (not yet available):**

- A workflow exists (`.github/workflows/build-ios.yml`) but is **manual trigger only**
- Requires an Apple Developer account ($99/yr) and signing secrets (`IOS_CERTIFICATE_P12`, `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE`, `APPLE_TEAM_ID`)
- iOS apps cannot be sideloaded like Android APKs — Apple requires code signing for all installs

**Local builds:**

```bash
npx expo run:android    # Android
npx expo run:ios        # iOS (macOS only, requires Xcode)
```

---

## 📜 Available Scripts

| Command                       | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `npm start`                   | Start the Expo development server             |
| `npm run web`                 | Start Expo for web                            |
| `npm run android`             | Build and run on Android                      |
| `npm run ios`                 | Build and run on iOS                          |
| `npm run lint`                | Run ESLint                                    |
| `npm run build:web`           | Export web build for deployment               |
| `npm run build:android`       | EAS production build for Android (app bundle) |
| `npm run build:android:local` | EAS production build locally                  |
| `npm run submit:android`      | Submit to Google Play via EAS                 |
| `npm run update`              | Push OTA update to production branch          |

Android versioning source of truth: `android/version.properties`

- `VERSION_CODE` is auto-incremented by `npm run build:android` and `npm run build:android:local` before each EAS build.
- `VERSION_NAME` is used as the app semantic version in Expo config.

### Backend

| Command                      | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `npm run dev`                | Start all 5 services concurrently (with --watch) |
| `npm run start:gateway`      | Start API Gateway service                        |
| `npm run start:safety`       | Start Safety Compute service                     |
| `npm run start:user`         | Start User Data service                          |
| `npm run start:subscription` | Start Subscription service                       |
| `npm run start:geocode`      | Start Geocode service                            |
| `npm run dev:gateway`        | Gateway with `--watch` (auto-restart)            |
| `npm run dev:safety`         | Safety with `--watch` (auto-restart)             |
| `npm run dev:user`           | User with `--watch` (auto-restart)               |
| `npm run dev:subscription`   | Subscription with `--watch` (auto-restart)       |
| `npm run dev:geocode`        | Geocode with `--watch` (auto-restart)            |

---

## 🔐 CI/CD Secrets (GitHub Actions)

For the build workflows to work, add these secrets in **Settings → Secrets → Actions**:

| Secret                             | Required for  | Description                                  |
| ---------------------------------- | ------------- | -------------------------------------------- |
| `EXPO_PUBLIC_API_BASE_URL`         | Android + iOS | Backend gateway URL                          |
| `EXPO_PUBLIC_SAFETY_API_URL`       | Android + iOS | Safety service URL                           |
| `EXPO_PUBLIC_USER_API_URL`         | Android + iOS | User data service URL                        |
| `EXPO_PUBLIC_SUBSCRIPTION_API_URL` | Android + iOS | Subscription service URL                     |
| `EXPO_PUBLIC_GEOCODE_API_URL`      | Android + iOS | Geocode service URL                          |
| `EXPO_PUBLIC_OSM_USER_AGENT`       | Android + iOS | User-agent string for Nominatim requests     |
| `EXPO_PUBLIC_OSM_EMAIL`            | Android + iOS | Contact email for Nominatim                  |
| `IOS_CERTIFICATE_P12`              | iOS only      | Base64-encoded .p12 distribution certificate |
| `IOS_CERTIFICATE_PASSWORD`         | iOS only      | Password for the .p12                        |
| `IOS_PROVISIONING_PROFILE`         | iOS only      | Base64-encoded .mobileprovision (Ad Hoc)     |
| `APPLE_TEAM_ID`                    | iOS only      | 10-character Apple Developer Team ID         |

---

## 🛠️ Tech Stack

| Layer                  | Technology                                                                      |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Frontend**           | React Native 0.81, Expo SDK 54, TypeScript 5.9                                  |
| **Routing**            | Expo Router 6 (file-based)                                                      |
| **Maps (iOS)**         | `react-native-maps` (Apple MapKit)                                              |
| **Maps (Android/Web)** | Leaflet via `react-native-webview`                                              |
| **Animations**         | `react-native-reanimated` 4.1                                                   |
| **Gestures**           | `react-native-gesture-handler` 2.28                                             |
| **Location**           | `expo-location` (foreground + background)                                       |
| **Camera**             | `expo-camera` (QR code scanning)                                                |
| **Push Notifications** | `expo-notifications`                                                            |
| **OTA Updates**        | `expo-updates`                                                                  |
| **Haptics**            | `expo-haptics`                                                                  |
| **Storage**            | `@react-native-async-storage/async-storage`                                     |
| **QR Codes**           | `react-native-qrcode-svg`                                                       |
| **Backend**            | Express 4.21 (Node.js), 5 microservices                                         |
| **Database**           | Supabase (Postgres + Auth)                                                      |
| **Payments**           | Stripe (checkout, portal, webhooks)                                             |
| **Email**              | Resend (transactional)                                                          |
| **Security**           | Helmet, CORS, express-rate-limit, JWT, input validation                         |
| **AI**                 | OpenAI GPT-4o-mini                                                              |
| **Deployment**         | Render.com (backend), Netlify (web), EAS Build (native), GitHub Actions (CI/CD) |

---

## ⚠️ Disclaimer

> **This app provides safety-related information but does not guarantee your safety.**
> Safety scores are estimates based on publicly available data (crime statistics, street lighting, CCTV locations, road classification) and do not reflect the real-time state of any location. Always stay aware of your surroundings and exercise personal judgment while travelling.

---

## 📄 Data Attribution

- **Crime data** — [data.police.uk](https://data.police.uk/) (Open Government Licence)
- **Map & road data** — © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- **Map tiles** — © OpenStreetMap tile servers

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## 📝 License

This project was created at **PlymHack 2026**. See the repository for licence details.
