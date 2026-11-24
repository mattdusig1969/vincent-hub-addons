/**
 * The brands the household can add by name, for devices the hub cannot find by listening.
 *
 * `how` says what happens when one is chosen:
 *   search   the hub goes looking on the network; nothing to type
 *   steps    the maker asks for something: an address, a sign-in, a code, a button press
 *   matter   added with the device's Matter code
 *   link     needs an account link on the maker's website (not possible in the app yet)
 *   none     the maker gives no way in; said plainly instead of leaving the household guessing
 *
 * `driver` is Home Assistant's name for the integration that talks to the brand.
 * `tips` is what to check first, shown before the search and again if nothing is found.
 */
import type { Brand } from "../../../packages/core/src/index.ts";

interface Entry extends Brand { driver?: string }

const B = (id: string, name: string, category: Brand["category"], how: Brand["how"], driver: string | undefined, tips: string, also?: string): Entry => ({ id, name, category, how, driver, tips, also });
/** A brand added with a Matter code: which of its devices that works for, and where the maker keeps the code. */
const M = (b: Entry, works: string, guide: string[]): Entry => ({ ...b, works, guide });

// Where each smart-home app keeps "share this device with another app". The code it gives is new each time.
const FROM_APPLE = ["Open the Home app on your iPhone and press and hold the device's tile, then tap Accessory Settings.", "Scroll to the bottom and tap Turn On Pairing Mode.", "A code appears. Tap Copy Code, or read it off, and enter it here."];
const FROM_GOOGLE = ["Open the Google Home app, tap Devices, then press and hold the device's tile.", "Tap the gear, then Linked Matter apps & services.", "Tap Link apps & services, then Use pairing code.", "Enter the code here straight away: Google's code lasts about three minutes."];
const FROM_ALEXA = ["Open the Alexa app, tap Devices and choose the device.", "Tap the gear, then Other Assistants and Apps.", "Tap Add Another. An 11-digit code appears; enter it here."];
const FROM_SMARTTHINGS = ["Open the SmartThings app and tap the device.", "Tap the three dots at the top right, then Share with other services.", "Choose Share (or Share device) and use the number under the square code."];
const FIRST_APP = "If it is already in Apple Home, Google Home or Alexa, its own code stops working and that app makes a new one: choose \"Already in Apple Home\", \"Already in Google Home\" or \"Already in Alexa\" from the brand list for the steps.";

export const BRANDS: Entry[] = [
  // Lights
  B("hue", "Philips Hue", "lights", "steps", "hue", "The Hue Bridge must be plugged into your router. You will be asked to press the button on top of the bridge."),
  M(B("govee", "Govee", "lights", "search", "govee_light_local", "Switch the light on. In the Govee app, open the light's settings and turn on LAN Control, then search. Lights with the Matter badge can be added with their code instead.", "matter"),
    "For Govee lights with the Matter badge on the box.",
    ["Open the Govee Home app and tap the light.", "Tap the gear at the top right.", "Scroll down to Other and tap Matter. The light's code appears.", "Enter that code here. If nothing is found, switch the light off and on at the wall and try again within 15 minutes.", FIRST_APP]),
  B("lifx", "LIFX", "lights", "search", "lifx", "Switch the light on at the wall. It must already be set up in the LIFX app and on your Wi-Fi."),
  M(B("kasa", "TP-Link Kasa and Tapo", "lights", "steps", "tplink", "Leave the address empty to search. Newer devices ask for your TP-Link account so the hub can talk to them directly. Models with the Matter badge can be added with a code instead.", "matter"),
    "For Tapo and Kasa models with the Matter badge (model numbers usually end in M).",
    ["Tapo app: tap the device, then the gear at the top right, then Matter Setup Code.", "Kasa app: tap the device, then the gear, then Device Info, then Matter Setup Code.", "Enter the code here. It lasts 15 minutes; keep that page open while you do."]),
  B("wled", "WLED", "lights", "steps", "wled", "Enter the strip's address, shown in the WLED app."),
  B("nanoleaf", "Nanoleaf", "lights", "steps", "nanoleaf", "You will be asked to hold the power button on the panels for a few seconds."),
  B("yeelight", "Yeelight", "lights", "steps", "yeelight", "Turn on LAN Control for the light in the Yeelight app first."),
  B("lutron", "Lutron Caséta", "lights", "steps", "lutron_caseta", "The Smart Hub must be plugged into your router. You will be asked to press the small button on its back."),
  B("shelly", "Shelly", "other", "steps", "shelly", "Enter the device's address, shown in the Shelly app."),
  B("wiz", "WiZ", "lights", "steps", "wiz", "Switch the light on. In the WiZ app, turn on Allow Local Communication."),
  B("elgato", "Elgato Key Light", "lights", "steps", "elgato", "Enter the light's address."),
  // Plugs and switches
  B("wemo", "Belkin Wemo", "other", "search", "wemo", "The plug must be set up in the Wemo app and on your Wi-Fi."),
  M(B("meross", "Meross", "other", "matter", undefined, "Meross plugs and switches with the Matter badge can be added with a code. Older Meross devices without the badge cannot be added.", "matter"),
    "For Meross devices with the Matter badge.",
    ["Meross sets its Matter devices up through Apple Home (iPhone) or Google Home (Android), so that app makes the code.", ...FROM_APPLE.map((x) => `iPhone: ${x}`), "Android: in Google Home, press and hold the device, tap the gear, Linked Matter apps & services, Link apps & services, Use pairing code.", "Never set up anywhere? Use the code printed on the plug itself."]),
  M(B("aqara", "Aqara", "other", "matter", undefined, "Aqara sensors, buttons and switches come in through an Aqara hub (M2, M3, M1S, E1 or the G3 camera hub).", "matter"),
    "For homes with an Aqara hub. Everything paired to the hub comes with it.",
    ["Open the Aqara Home app and tap Accessories, then your hub.", "Tap the three dots at the top right.", "Tap Matter (on some versions: Third-Party Matter Ecosystems).", "Tap Matter Pairing Code and enter the number here. It lasts 15 minutes."]),
  M(B("switchbot", "SwitchBot", "other", "matter", undefined, "SwitchBot curtains, locks and buttons come in through a SwitchBot hub (Hub 2, Hub 3, or the Hub Mini marked Matter Enabled).", "matter"),
    "For homes with a SwitchBot hub.",
    ["Open the SwitchBot app and tap your hub.", "Tap the gear, then Matter Setup.", "Enter the code shown there here.", "Afterwards, go back to Matter Setup, tap Secondary Devices, and add each curtain, lock or button you want Vincent to see.", FIRST_APP]),
  M(B("leviton", "Leviton Decora Smart", "lights", "matter", undefined, "Leviton's second-generation Decora Smart Wi-Fi switches, dimmers and plugs can be added with a code.", "matter"),
    "For Decora Smart Wi-Fi 2nd Gen (models starting D2). First-generation models cannot be added.",
    ["In the My Leviton app, join the Matter Early Access Program and run System Updates (once).", "Tap the switch or dimmer, then Device Settings.", "Tap Matter Pairing Code and enter the number under the square code here."]),
  B("amazon_echo", "Amazon Echo (Alexa)", "media", "steps", "alexa_media", "Sign in with the Amazon account your Echo speakers are on. Amazon's own sign-in page opens for it: you type your email and password there, and a code texted to your phone works. The first time, the hub takes about two minutes to get ready."),
  B("amazon_plug", "Amazon Smart Plug", "other", "none", undefined, "Amazon's own plugs can only be controlled through Alexa. Limited by manufacturer."),
  B("wyze", "Wyze", "other", "none", undefined, "Wyze devices work only through the Wyze app and account. Limited by manufacturer."),
  B("smartthings", "SmartThings", "other", "link", "smartthings", "SmartThings needs an account link on Samsung's website."),
  // Music and TV
  B("sonos", "Sonos", "media", "search", "sonos", "Speakers must be set up in the Sonos app and on the same network as the hub."),
  B("apple_tv", "Apple TV", "media", "steps", "apple_tv", "Have the TV on. Enter the Apple TV's name as it appears on your network; a code will show on the TV to type here."),
  B("roku", "Roku", "media", "steps", "roku", "Enter the Roku's address, shown in its Settings under Network, About."),
  B("samsung_tv", "Samsung TV", "media", "steps", "samsungtv", "Have the TV on. Enter its address; the TV will ask you to allow the connection."),
  B("lg_tv", "LG TV", "media", "steps", "webostv", "Have the TV on. Enter its address; the TV will ask you to accept."),
  B("cast", "Chromecast and Google speakers", "media", "search", "cast", "They must be set up in the Google Home app and on your Wi-Fi."),
  B("android_tv", "Android TV and Google TV", "media", "steps", "androidtv_remote", "Have the TV on. A code will show on the TV to type here."),
  B("denon", "Denon and Marantz", "media", "steps", "denonavr", "Leave the address empty to search, or enter the receiver's address."),
  B("yamaha", "Yamaha MusicCast", "media", "steps", "yamaha_musiccast", "Enter the receiver's or speaker's address."),
  B("heos", "HEOS", "media", "steps", "heos", "Enter the address of any one HEOS speaker."),
  B("bluesound", "Bluesound", "media", "steps", "bluesound", "Enter the player's address."),
  // Climate
  M(B("nest_thermostat", "Google Nest thermostat", "climate", "matter", undefined, "Only two Nest thermostats can be added today: the Nest Thermostat (2020, the mirrored one) and the Nest Learning Thermostat 4th generation. The 3rd generation and earlier, and the Nest Thermostat E, have no code to give and cannot be added yet. If Google Home shows no Linked Matter apps & services for yours, it is one of those.", "matter"),
    "For the Nest Thermostat (2020) and the Nest Learning Thermostat 4th generation. Older Nest thermostats cannot be added yet.",
    FROM_GOOGLE),
  B("nest", "Google Nest cameras and doorbells", "security", "link", "nest", "Nest cameras and doorbells need an account link on Google's website."),
  B("ecobee", "ecobee", "climate", "steps", "homekit_controller", "ecobee thermostats are added with their HomeKit code. On the thermostat: Menu, Settings, Reset, Reset HomeKit, then find the code under Menu, Settings, HomeKit."),
  B("honeywell", "Honeywell Total Connect Comfort", "climate", "steps", "honeywell", "You will be asked for your Total Connect Comfort sign-in."),
  B("sensibo", "Sensibo", "climate", "steps", "sensibo", "You will be asked for an API key, made on Sensibo's website under your account."),
  B("tado", "tado°", "climate", "link", "tado", "tado° needs an account link on tado's website."),
  // Security
  B("ring", "Ring", "security", "steps", "ring", "You will be asked for your Ring sign-in and the code Ring texts you. Limited by manufacturer: Ring is controlled through Ring's own service."),
  B("reolink", "Reolink", "security", "steps", "reolink", "Enter the camera's or recorder's address and its own sign-in (not the Reolink app account)."),
  B("unifi", "UniFi Protect", "security", "steps", "unifiprotect", "Enter the console's address and a local user made for the hub."),
  B("onvif", "Other cameras (ONVIF)", "security", "steps", "onvif", "Most network cameras speak ONVIF once it is switched on in the camera's own settings. You will need its address and sign-in."),
  B("eufy_camera", "eufy cameras", "security", "steps", "generic", "For eufy's plug-in cameras that can send a stream (Indoor Cam, Wired Cam C31 and similar). First, in the eufy app: tap the camera, then Settings, Storage, NAS (RTSP Stream). Switch it on and set recording to Continuous. The app then shows an address starting rtsp:// with a username and a password; you type those three here. Battery cameras and doorbells have no such setting and work only in the eufy app."),
  B("camera_stream", "Other cameras (stream address)", "security", "steps", "generic", "For any camera that gives a stream address starting rtsp://. Its own app or manual shows the address, and a username and password if it has them."),
  M(B("eufy", "eufy", "security", "matter", undefined, "For eufy's Wi-Fi smart locks (FamiLock S3 and S3 Max). For eufy cameras, choose eufy cameras from the brand list.", "matter"),
    "For eufy FamiLock S3 and S3 Max. Other eufy locks use Thread, which this hub cannot reach yet.",
    ["Open the eufy app, tap the lock, then Settings.", "Tap Work with Matter, then Connect to Third-party Ecosystem.", "Tap Start Pairing. The lock's light blinks blue.", "Scan the Matter code on the lock or its box here.", FIRST_APP]),
  B("blink", "Blink", "security", "steps", "blink", "You will be asked for your Blink sign-in and the code Blink sends you."),
  B("schlage", "Schlage", "security", "steps", "schlage", "You will be asked for your Schlage Home sign-in."),
  B("yale", "Yale and August", "security", "link", "yale", "Yale and August need an account link on their website."),
  B("arlo", "Arlo", "security", "none", undefined, "Arlo cameras work only through the Arlo app and account. Limited by manufacturer."),
  B("simplisafe", "SimpliSafe", "security", "link", "simplisafe", "SimpliSafe needs an account link on its website."),
  // By code
  M(B("from_apple", "Already in Apple Home", "other", "matter", undefined, "A device you already use in Apple Home can be shared with Vincent, and keeps working in Apple Home too.", "matter"),
    "For devices added to Apple Home with a Matter code. If there is no Turn On Pairing Mode row, the device cannot be shared this way.", FROM_APPLE),
  M(B("from_google", "Already in Google Home", "other", "matter", undefined, "A device you already use in Google Home can be shared with Vincent, and keeps working in Google Home too.", "matter"),
    "For Matter devices in Google Home.", FROM_GOOGLE),
  M(B("from_alexa", "Already in Alexa", "other", "matter", undefined, "A light, plug or lock you already use with Alexa can be shared with Vincent, and keeps working with Alexa too. For Echo speakers themselves, choose Amazon Echo (Alexa).", "matter"),
    "For lights, plugs and locks that were added to Alexa with a Matter code. Devices linked through a skill have no such option, and an Echo speaker itself is added another way: choose Amazon Echo (Alexa) from the brand list.", FROM_ALEXA),
  M(B("from_smartthings", "Already in SmartThings", "other", "matter", undefined, "A Matter device in SmartThings can be shared with Vincent.", "matter"),
    "For Matter devices in SmartThings.", FROM_SMARTTHINGS),
  B("matter", "Anything with a Matter code", "other", "matter", undefined, "Matter is a shared language many newer bulbs, plugs, locks and sensors speak. The device must already be on your Wi-Fi, through its maker's app or another smart-home app. Ask that app for a Matter code to share it."),
  B("homekit", "Anything with a HomeKit code", "other", "steps", "homekit_controller", "The device must not be in Apple Home at the same time: remove it there first. Then it appears here to be paired with the eight-digit code on its label."),
];

export const brandList = (): Brand[] => BRANDS.map(({ driver: _driver, ...b }) => b);
export const brand = (id: string): Entry | undefined => BRANDS.find((b) => b.id === id);
