/*
 * GLV's own list of SDKs found inside mobile apps: what each one is, and whether it tracks users
 * (ads, attribution, analytics that build profiles). Android SDKs are found by their package path
 * in the app's code (Lcom/appsflyer/), iOS SDKs by their framework name or a class they always have.
 * Add an SDK by adding a line; nothing here calls an outside service.
 */

export type SdkKind = "ads" | "attribution" | "analytics" | "crash" | "push" | "social" | "payments" | "maps" | "support" | "other";

export interface SdkInfo {
  id: string;
  name: string;
  maker: string;
  kind: SdkKind;
  /** It collects data to follow users across apps or build profiles (stores call this tracking). */
  tracker: boolean;
  /** Android package paths in the code, like "com/appsflyer/". */
  android: string[];
  /** iOS framework names or class names, like "AppsFlyerLib". */
  ios: string[];
  /** Servers it sends data to, for the device test's traffic check. */
  hosts?: string[];
}

export const SDKS: SdkInfo[] = [
  // Ads
  { id: "admob", name: "Google AdMob", maker: "Google", kind: "ads", tracker: true, android: ["com/google/android/gms/ads/"], ios: ["GoogleMobileAds", "GADMobileAds"], hosts: ["googleads.g.doubleclick.net", "pagead2.googlesyndication.com"] },
  { id: "meta-audience", name: "Meta Audience Network", maker: "Meta", kind: "ads", tracker: true, android: ["com/facebook/ads/"], ios: ["FBAudienceNetwork"], hosts: ["an.facebook.com"] },
  { id: "applovin", name: "AppLovin", maker: "AppLovin", kind: "ads", tracker: true, android: ["com/applovin/"], ios: ["AppLovinSDK", "ALSdk"], hosts: ["applovin.com"] },
  { id: "unity-ads", name: "Unity Ads", maker: "Unity", kind: "ads", tracker: true, android: ["com/unity3d/ads/", "com/unity3d/services/"], ios: ["UnityAds"], hosts: ["unityads.unity3d.com"] },
  { id: "ironsource", name: "ironSource", maker: "Unity", kind: "ads", tracker: true, android: ["com/ironsource/"], ios: ["IronSource"], hosts: ["supersonicads.com"] },
  { id: "vungle", name: "Liftoff Vungle", maker: "Liftoff", kind: "ads", tracker: true, android: ["com/vungle/"], ios: ["VungleSDK", "VungleAdsSDK"] },
  { id: "inmobi", name: "InMobi", maker: "InMobi", kind: "ads", tracker: true, android: ["com/inmobi/"], ios: ["InMobiSDK"] },
  { id: "chartboost", name: "Chartboost", maker: "Chartboost", kind: "ads", tracker: true, android: ["com/chartboost/"], ios: ["ChartboostSDK", "Chartboost"] },
  { id: "pangle", name: "Pangle", maker: "ByteDance", kind: "ads", tracker: true, android: ["com/bytedance/sdk/openadsdk/"], ios: ["PAGAdSDK", "BUAdSDK"] },
  // Attribution
  { id: "appsflyer", name: "AppsFlyer", maker: "AppsFlyer", kind: "attribution", tracker: true, android: ["com/appsflyer/"], ios: ["AppsFlyerLib"], hosts: ["appsflyer.com", "appsflyersdk.com"] },
  { id: "adjust", name: "Adjust", maker: "Adjust", kind: "attribution", tracker: true, android: ["com/adjust/sdk/"], ios: ["AdjustSdk", "Adjust"], hosts: ["adjust.com"] },
  { id: "branch", name: "Branch", maker: "Branch", kind: "attribution", tracker: true, android: ["io/branch/referral/"], ios: ["BranchSDK", "Branch"], hosts: ["api2.branch.io", "api.branch.io"] },
  { id: "kochava", name: "Kochava", maker: "Kochava", kind: "attribution", tracker: true, android: ["com/kochava/"], ios: ["KochavaTracker"] },
  { id: "singular", name: "Singular", maker: "Singular", kind: "attribution", tracker: true, android: ["com/singular/sdk/"], ios: ["Singular"] },
  { id: "meta-sdk", name: "Facebook SDK (Meta)", maker: "Meta", kind: "social", tracker: true, android: ["com/facebook/appevents/", "com/facebook/FacebookSdk"], ios: ["FBSDKCoreKit"], hosts: ["graph.facebook.com"] },
  // Analytics
  { id: "firebase-analytics", name: "Firebase Analytics", maker: "Google", kind: "analytics", tracker: true, android: ["com/google/firebase/analytics/", "com/google/android/gms/measurement/"], ios: ["FirebaseAnalytics", "GoogleAppMeasurement"], hosts: ["app-measurement.com", "firebaselogging-pa.googleapis.com"] },
  { id: "google-analytics", name: "Google Analytics (old)", maker: "Google", kind: "analytics", tracker: true, android: ["com/google/android/gms/analytics/"], ios: ["GAI", "GoogleAnalytics"] },
  { id: "mixpanel", name: "Mixpanel", maker: "Mixpanel", kind: "analytics", tracker: true, android: ["com/mixpanel/android/"], ios: ["Mixpanel"], hosts: ["api.mixpanel.com"] },
  { id: "amplitude", name: "Amplitude", maker: "Amplitude", kind: "analytics", tracker: true, android: ["com/amplitude/"], ios: ["Amplitude", "AmplitudeSwift"], hosts: ["api2.amplitude.com"] },
  { id: "clevertap", name: "CleverTap", maker: "CleverTap", kind: "analytics", tracker: true, android: ["com/clevertap/android/"], ios: ["CleverTapSDK"], hosts: ["clevertap-prod.com", "wzrkt.com"] },
  { id: "moengage", name: "MoEngage", maker: "MoEngage", kind: "analytics", tracker: true, android: ["com/moengage/"], ios: ["MoEngage", "MoEngageSDK"] },
  { id: "webengage", name: "WebEngage", maker: "WebEngage", kind: "analytics", tracker: true, android: ["com/webengage/"], ios: ["WebEngage"] },
  { id: "segment", name: "Segment", maker: "Twilio", kind: "analytics", tracker: true, android: ["com/segment/analytics/"], ios: ["Segment", "SEGAnalytics"], hosts: ["api.segment.io"] },
  { id: "flurry", name: "Flurry", maker: "Yahoo", kind: "analytics", tracker: true, android: ["com/flurry/"], ios: ["Flurry"] },
  { id: "hotjar-like", name: "Smartlook", maker: "Smartlook", kind: "analytics", tracker: true, android: ["com/smartlook/"], ios: ["Smartlook"] },
  { id: "uxcam", name: "UXCam (screen recording)", maker: "UXCam", kind: "analytics", tracker: true, android: ["com/uxcam/"], ios: ["UXCam"] },
  { id: "clarity", name: "Microsoft Clarity (screen recording)", maker: "Microsoft", kind: "analytics", tracker: true, android: ["com/microsoft/clarity/"], ios: ["Clarity"] },
  { id: "posthog", name: "PostHog", maker: "PostHog", kind: "analytics", tracker: false, android: ["com/posthog/"], ios: ["PostHog"] },
  // Crash and performance
  { id: "crashlytics", name: "Firebase Crashlytics", maker: "Google", kind: "crash", tracker: false, android: ["com/google/firebase/crashlytics/"], ios: ["FirebaseCrashlytics"] },
  { id: "sentry", name: "Sentry", maker: "Sentry", kind: "crash", tracker: false, android: ["io/sentry/"], ios: ["Sentry"] },
  { id: "bugsnag", name: "Bugsnag", maker: "SmartBear", kind: "crash", tracker: false, android: ["com/bugsnag/"], ios: ["Bugsnag"] },
  { id: "instabug", name: "Instabug", maker: "Instabug", kind: "crash", tracker: false, android: ["com/instabug/"], ios: ["Instabug"] },
  { id: "newrelic", name: "New Relic", maker: "New Relic", kind: "crash", tracker: false, android: ["com/newrelic/agent/"], ios: ["NewRelic"] },
  // Push and messaging
  { id: "fcm", name: "Firebase Cloud Messaging", maker: "Google", kind: "push", tracker: false, android: ["com/google/firebase/messaging/"], ios: ["FirebaseMessaging"] },
  { id: "onesignal", name: "OneSignal", maker: "OneSignal", kind: "push", tracker: true, android: ["com/onesignal/"], ios: ["OneSignal", "OneSignalFramework"], hosts: ["api.onesignal.com", "onesignal.com"] },
  { id: "braze", name: "Braze", maker: "Braze", kind: "push", tracker: true, android: ["com/braze/", "com/appboy/"], ios: ["BrazeKit", "Appboy"] },
  // Sign-in and social
  { id: "google-signin", name: "Google Sign-In", maker: "Google", kind: "social", tracker: false, android: ["com/google/android/gms/auth/api/signin/"], ios: ["GoogleSignIn", "GIDSignIn"] },
  { id: "truecaller", name: "Truecaller SDK", maker: "Truecaller", kind: "social", tracker: false, android: ["com/truecaller/android/sdk/"], ios: ["TrueSDK"] },
  // Payments
  { id: "razorpay", name: "Razorpay", maker: "Razorpay", kind: "payments", tracker: false, android: ["com/razorpay/"], ios: ["Razorpay"] },
  { id: "paytm", name: "Paytm All-in-One", maker: "Paytm", kind: "payments", tracker: false, android: ["com/paytm/pgsdk/", "net/one97/paytm/"], ios: ["AppInvokeSDK", "PaytmSDK"] },
  { id: "phonepe", name: "PhonePe", maker: "PhonePe", kind: "payments", tracker: false, android: ["com/phonepe/intent/sdk/"], ios: ["PhonePePayment"] },
  { id: "cashfree", name: "Cashfree", maker: "Cashfree", kind: "payments", tracker: false, android: ["com/cashfree/pg/"], ios: ["CashfreePG", "CashfreePGCoreSDK"] },
  { id: "stripe", name: "Stripe", maker: "Stripe", kind: "payments", tracker: false, android: ["com/stripe/android/"], ios: ["Stripe", "StripeCore"] },
  { id: "play-billing", name: "Google Play Billing", maker: "Google", kind: "payments", tracker: false, android: ["com/android/billingclient/"], ios: [] },
  // Maps and support
  { id: "google-maps", name: "Google Maps", maker: "Google", kind: "maps", tracker: false, android: ["com/google/android/gms/maps/"], ios: ["GoogleMaps", "GMSMapView"] },
  { id: "mapbox", name: "Mapbox", maker: "Mapbox", kind: "maps", tracker: false, android: ["com/mapbox/"], ios: ["MapboxMaps", "Mapbox"] },
  { id: "freshchat", name: "Freshchat", maker: "Freshworks", kind: "support", tracker: false, android: ["com/freshchat/"], ios: ["FreshchatSDK"] },
  { id: "intercom", name: "Intercom", maker: "Intercom", kind: "support", tracker: false, android: ["io/intercom/android/"], ios: ["Intercom"] },
  { id: "zendesk", name: "Zendesk", maker: "Zendesk", kind: "support", tracker: false, android: ["zendesk/"], ios: ["ZendeskSDK", "SupportSDK"] },
];

export const KIND_LABEL: Record<SdkKind, string> = {
  ads: "Ads",
  attribution: "Install tracking",
  analytics: "Analytics",
  crash: "Crash reports",
  push: "Push messages",
  social: "Sign-in and social",
  payments: "Payments",
  maps: "Maps",
  support: "Support chat",
  other: "Other",
};

/** The SDKs whose package paths appear in Android code (dex) text. */
export function androidSdks(texts: string[]): SdkInfo[] {
  return SDKS.filter((s) => s.android.some((p) => texts.some((t) => t.includes(`L${p}`))));
}

/** The SDKs an iOS app carries: by framework name, or by a class name in its program files. */
export function iosSdks(frameworks: string[], programs: string[]): SdkInfo[] {
  return SDKS.filter((s) =>
    s.ios.some((n) => frameworks.includes(n) || programs.some((t) => t.includes(`_OBJC_CLASS_$_${n}\0`) || t.includes(`\0${n}.framework/`))),
  );
}

/** The SDK a server belongs to, for traffic the app sent while it ran. */
export function sdkForHost(host: string): SdkInfo | undefined {
  const h = host.toLowerCase();
  return SDKS.find((s) => s.hosts?.some((x) => h === x || h.endsWith(`.${x}`)));
}
