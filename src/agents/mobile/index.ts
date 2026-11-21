import { ANDROID_AGENTS } from "./android.js";
import { ANDROID_EXTRA_AGENTS } from "./android-extra.js";
import { IOS_AGENTS } from "./ios.js";
import { IOS_EXTRA_AGENTS } from "./ios-extra.js";

/** Every Android check, in the order they run. */
export const ALL_ANDROID_AGENTS = [...ANDROID_AGENTS, ...ANDROID_EXTRA_AGENTS];
/** Every iOS check, in the order they run. */
export const ALL_IOS_AGENTS = [...IOS_AGENTS, ...IOS_EXTRA_AGENTS];
