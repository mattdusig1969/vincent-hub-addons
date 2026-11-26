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

type Told = Omit<Brand, "fit" | "needs" | "models">;
interface Entry extends Told { driver?: string }

const B = (id: string, name: string, category: Told["category"], how: Told["how"], driver: string | undefined, tips: string, also?: string): Entry => ({ id, name, category, how, driver, tips, also });
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
  B("hue", "Philips Hue", "lights", "steps", "hue", "The Hue Bridge must be on your home network: the standard bridge plugs into your router, and the Bridge Pro can also use Wi-Fi. You will be asked to press the button on the bridge. Hue bulbs used without a bridge (Bluetooth only) cannot be added."),
  M(B("govee", "Govee", "lights", "search", "govee_light_local", "In the Govee app, open the light, tap the gear and turn on LAN Control, then search. If the switch is missing, unplug the light, plug it back in and wait up to 30 minutes. If it never appears, that light cannot be added this way. Lights with the Matter badge can be added with their code instead.", "matter"),
    "For Govee lights with the Matter badge on the box.",
    ["Open the Govee Home app and tap the light.", "Tap the gear at the top right.", "Scroll down to Other and tap Matter. The light's code appears.", "Enter that code here. If nothing is found, switch the light off and on at the wall and try again within 15 minutes.", FIRST_APP]),
  B("lifx", "LIFX", "lights", "search", "lifx", "Switch the light on at the wall. It must already be set up in the LIFX app and on the same Wi-Fi network as the hub. The LIFX Switch (the wall switch) is not found by the search: add it with its Matter code instead."),
  M(B("kasa", "TP-Link Kasa and Tapo", "lights", "steps", "tplink", "Leave the address empty to search. Tapo devices and newer Kasa devices ask for your TP-Link account so the hub can talk to them directly; type the email exactly as you registered it. If the hub cannot connect, switch on Third-Party Compatibility first: in the Tapo app under Me, Tapo Lab; in the Kasa app under Settings. Models with the Matter badge can be added with a code instead.", "matter"),
    "For Tapo and Kasa models with the Matter badge on the box.",
    ["Tapo app: tap the device, then the gear at the top right, then Matter Setup Code.", "Kasa app: tap the device, then the gear, then Device Info, then Matter Setup Code.", "Enter the code here. It lasts 15 minutes; keep that page open while you do."]),
  B("wled", "WLED", "lights", "steps", "wled", "The hub usually finds the strip by itself. If not, enter the strip's address, shown in the WLED app. The strip needs WLED version 0.14 or newer."),
  B("nanoleaf", "Nanoleaf", "lights", "steps", "nanoleaf", "Hold the power button on the panel controller for 5 to 7 seconds until its lights start flashing, then continue within 30 seconds."),
  B("yeelight", "Yeelight", "lights", "steps", "yeelight", "Set the light up in the Yeelight app and update it, then turn on LAN Control for that light (older versions of the app call it Developer mode)."),
  B("lutron", "Lutron Caséta", "lights", "steps", "lutron_caseta", "The Smart Hub must be plugged into your router. You will be asked to press the small button on its back. Also works with RA2 Select, RadioRA 3 and HomeWorks QSX. Older RadioRA 2 and HomeWorks QS are not supported."),
  B("shelly", "Shelly", "other", "steps", "shelly", "The device must be on your Wi-Fi, set up in the Shelly app first. For battery models, press the device's button to wake it just before adding. If the hub does not find it, enter its address, shown in the Shelly app. Shelly BLU Bluetooth sensors and buttons are not added this way."),
  B("wiz", "WiZ", "lights", "steps", "wiz", "Switch the light on. If it is not found, open the WiZ app, go to Settings, then Security, and check that Allow Local Communication is on (it normally is)."),
  B("elgato", "Elgato Key Light", "lights", "steps", "elgato", "The hub usually finds the light by itself. The light must be switched on and on your Wi-Fi. If it is not found, enter the light's address."),
  // Plugs and switches
  B("wemo", "Belkin Wemo", "other", "search", "wemo", "The plug must already be on your Wi-Fi. Belkin closed the Wemo app on January 31, 2026, so a new or reset Wemo device can no longer be set up."),
  M(B("meross", "Meross", "other", "matter", undefined, "Meross devices with the Matter badge can be added with the code on the device's sticker. Meross devices whose sticker shows a small house beside an eight-digit code are Apple Home devices: set the device up in the Meross app first so it is on your Wi-Fi, then scan that code here. If it is also in Apple Home, remove it there first. Do not delete the device from the Meross app afterwards: that resets it. Devices without the badge cannot be added.", "matter"),
    "For Meross devices with the Matter badge.",
    ["Find the Matter code: it is on a sticker on the device itself, or in its box.", "Scan or type it here.", "Already in Apple Home, Google Home or Alexa? Then the sticker code no longer works and that app makes a new one.", ...FROM_APPLE.map((x) => `iPhone: ${x}`), "Android: in Google Home, press and hold the device, tap the gear, Linked Matter apps & services, Link apps & services, Use pairing code."]),
  M(B("aqara", "Aqara", "other", "matter", undefined, "Aqara sensors, buttons and switches come in through an Aqara hub (M3, M200, M100, M2, M1S, E1, or the G3, G5 Pro or G410 camera hubs). Update the hub and the Aqara Home app first.", "matter"),
    "For homes with an Aqara hub. Everything paired to the hub comes with it.",
    ["Open the Aqara Home app and tap Accessories, then your hub.", "Tap the three dots at the top right.", "Tap Matter (on some versions: Third-Party Matter Ecosystems).", "Tap Matter Pairing Code and enter the number here. It lasts 15 minutes."]),
  M(B("switchbot", "SwitchBot", "other", "matter", undefined, "SwitchBot curtains, locks, sensors and buttons come in through a SwitchBot hub (Hub 2, Hub 3, AI Hub, or the Hub Mini marked Matter Enabled). Each hub passes on a limited number of devices: Hub Mini 4, Hub 2 8, Hub 3 and AI Hub 30.", "matter"),
    "For homes with a SwitchBot hub, or with SwitchBot Wi-Fi products that have Matter built in.",
    ["Open the SwitchBot app and tap your hub.", "Tap the gear, then Matter Setup.", "Enter the code shown there here.", "Afterwards, go back to Matter Setup, tap Secondary Devices, and add each curtain, lock or button you want Vincent to see.", FIRST_APP]),
  M(B("leviton", "Leviton Decora Smart", "lights", "matter", undefined, "Leviton's second-generation Decora Smart Wi-Fi switches, dimmers, plugs, outlets and fan controllers can be added with a code, and the newer D3 models come ready for it. Note: Leviton's Matter update removes the device from Apple Home; it has to be added there again with the Matter code.", "matter"),
    "For Decora Smart Wi-Fi 2nd Gen (models starting D2) and the newer D3 models. First-generation models cannot be added.",
    ["Older D2 models: in the My Leviton app, join the Matter Early Access Program and run System Updates (once). D3 models skip this.", "Tap the switch or dimmer, then Device Settings.", "Tap Matter Pairing Code and enter the number under the square code here."]),
  B("amazon_echo", "Amazon Echo (Alexa)", "media", "steps", "alexa_media", "Sign in with the Amazon account your Echo speakers are on. Amazon's own sign-in page opens for it: you type your email and password there. If Amazon refuses the code it texts you, use an authenticator app instead: at amazon.com open Account, then Login & security, then 2-step verification, and choose Add new app. Scan the square code it shows with an authenticator app (Google Authenticator, Microsoft Authenticator or the one built into iPhone Passwords), then sign in here again and type the six digits from that app. The first time, the hub takes about two minutes to get ready."),
  B("amazon_plug", "Amazon Smart Plug", "other", "matter", undefined, "Check the plug for the Matter badge. The Amazon Basics Smart Plug has it and can be added with the code in its box. The older Amazon Smart Plug has no badge and works only through Alexa.", "matter"),
  B("wyze", "Wyze", "other", "none", undefined, "Wyze devices work only through the Wyze app and account. Limited by manufacturer."),
  B("smartthings", "SmartThings", "other", "link", "smartthings", "SmartThings needs an account link with Samsung, and from December 15, 2026 a paid Samsung plan. The easier way: devices in SmartThings that speak Matter can be shared to Vincent with a code, with no Samsung plan."),
  // Music and TV
  B("sonos", "Sonos", "media", "search", "sonos", "Speakers must be set up in the Sonos app and on the same network as the hub. If they are not found, check that UPnP is switched on in the Sonos app (Account, Privacy and Security). Portable speakers must be awake and on Wi-Fi, not Bluetooth."),
  B("apple_tv", "Apple TV", "media", "steps", "apple_tv", "Have the TV on. The hub usually finds it by itself; otherwise enter its name or address. A code shows on the TV to type here, sometimes more than once. If no code appears, on the Apple TV go to Settings, AirPlay and HomeKit, and set Allow Access to Everyone on the Same Network."),
  B("roku", "Roku", "media", "steps", "roku", "The hub usually finds the Roku by itself. If not, enter its address, shown in its Settings under Network, About. If it still will not connect, on the Roku go to Settings, System, Advanced system settings, Control by mobile apps, and allow network access. Roku sticks, boxes and Roku TVs work; Roku's cameras, bulbs and plugs do not."),
  B("samsung_tv", "Samsung TV", "media", "steps", "samsungtv", "Have the TV on and on the same network as the hub. The TV will ask you to allow the connection. If it is not found, enter its address. Works with Samsung smart TVs from 2016 on. If the TV keeps asking, open its Device connection manager and set Access notification to First time only."),
  B("lg_tv", "LG TV", "media", "steps", "webostv", "Have the TV on and accept the request on its screen. If it is not found, enter the TV's address. If pairing fails, turn on LG Connect Apps in the TV's Network settings."),
  B("cast", "Chromecast and Google speakers", "media", "search", "cast", "They must be set up in the Google Home app and on the same home network as the hub. Devices on a separate guest network will not be found. Covers Chromecast, Google TV Streamer, Nest and Google Home speakers and displays, and TVs with Chromecast built in."),
  B("android_tv", "Android TV and Google TV", "media", "steps", "androidtv_remote", "Have the TV on and on the same network as the hub. A code will show on the TV to type here. Works with TVs and boxes running Android TV or Google TV (Sony, TCL, Hisense, Philips, Nvidia Shield, Google TV Streamer). Amazon Fire TV does not work this way."),
  B("denon", "Denon and Marantz", "media", "steps", "denonavr", "Have the receiver on and connected to your network. Leave the address empty to search, or enter the receiver's address. On Marantz, turn on Auto-Standby in the receiver's settings so the hub can switch it on."),
  B("yamaha", "Yamaha MusicCast", "media", "steps", "yamaha_musiccast", "The hub usually finds it by itself. If not, enter the receiver's or speaker's address. Only Yamaha models with MusicCast work."),
  B("heos", "HEOS", "media", "steps", "heos", "The hub usually finds HEOS by itself. If asked for an address, pick a HEOS device that is wired to your network and always on; one device brings in all the others."),
  B("bluesound", "Bluesound", "media", "steps", "bluesound", "The player is usually found by itself. If not, enter its address."),
  B("sony_tv", "Sony TV", "media", "steps", "braviatv", "Have the TV on. A code shows on the TV to type here. If asked for an address, it is under the TV's Settings, Network. Sony TVs with Google TV can also be added as Android TV and Google TV."),
  B("vizio", "Vizio TV and soundbars", "media", "steps", "vizio", "Have it on and on the same network as the hub. A TV shows a code to type here; a soundbar needs nothing more. Its address is shown in its own network settings: four numbers with dots."),
  B("philips_tv", "Philips TV", "media", "steps", "philips_js", "Have the TV on. Newer sets show a code to type here. Its address is shown in its own network settings: four numbers with dots. Philips TVs with Google TV can also be added as Android TV and Google TV."),
  B("panasonic_tv", "Panasonic TV", "media", "steps", "panasonic_viera", "Have the TV on. On the TV, turn on TV Remote under Network settings first. A code shows on the TV to type here. Its address is shown in its own network settings: four numbers with dots."),
  B("lg_old", "LG TV (before 2014)", "media", "steps", "lg_netcast", "For older LG smart TVs that do not run webOS. A code shows on the TV to type here. Its address is shown in its own network settings: four numbers with dots."),
  B("fire_tv", "Amazon Fire TV", "media", "steps", "androidtv", "On the Fire TV, open Settings, My Fire TV, Developer Options and turn on ADB Debugging. (No Developer Options? Open About and press select on the device's name seven times.) Enter the Fire TV's address, found under Settings, My Fire TV, About, Network. Then say Allow on the TV, ticking Always allow."),
  B("directv", "DirecTV", "media", "steps", "directv", "The receiver is usually found by itself. On the receiver, allow External Access under Settings, Whole-Home. Its address is shown in its own network settings: four numbers with dots."),
  B("ps4", "PlayStation 4", "media", "steps", "ps4", "Needs the PS4 Second Screen app on your phone and a code from the console: Settings, Mobile App Connection Settings, Add Device. A PlayStation 5 cannot be controlled over the network; a scene can still switch the TV to it."),
  B("epson", "Epson projectors", "media", "steps", "epson", "The projector must be on your home network (wired, or with its Wi-Fi module) and switched on. Its address is shown in its own network settings: four numbers with dots."),
  B("jvc", "JVC projectors", "media", "steps", "jvc_projector", "The projector must be wired to your home network. If its network settings show a password, you are asked for it. Its address is shown in its own network settings: four numbers with dots."),
  B("pjlink", "Other projectors (Sony, BenQ, Optoma, Panasonic, NEC, ViewSonic)", "media", "steps", "pjlink", "Most network projectors speak a shared language called PJLink. Turn on PJLink (or Network Control) in the projector's network settings, and note the password if it shows one. Its address is shown in its own network settings: four numbers with dots."),
  B("madvr", "madVR Envy", "media", "steps", "madvr", "The Envy must be on and wired to your home network. Its address is shown in its own network settings: four numbers with dots."),
  B("onkyo", "Onkyo, Pioneer and Integra", "media", "steps", "onkyo", "Have the receiver on and on your home network. It is usually found by itself. In the receiver's settings, turn on Network Standby so the hub can switch it on."),
  B("sony_audio", "Sony receivers and soundbars", "media", "steps", "songpal", "For Sony receivers, soundbars and speakers that work with the Sony Music Center app. Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("anthem", "Anthem", "media", "steps", "anthemav", "Have the receiver on and wired or joined to your home network. Its address is shown in its own network settings: four numbers with dots."),
  B("arcam", "Arcam", "media", "steps", "arcam_fmj", "Have the receiver on. In its settings, turn on IP Control (Net Control). It is often found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("cambridge", "Cambridge Audio", "media", "steps", "cambridge_audio", "For Cambridge Audio network players and amplifiers that work with the StreamMagic app. Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("lyngdorf", "Lyngdorf", "media", "steps", "lyngdorf", "Have the amplifier or processor on and on your home network. Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("bose", "Bose SoundTouch", "media", "steps", "soundtouch", "For Bose SoundTouch speakers and soundbars. Usually found by itself. Its address is shown in its own network settings: four numbers with dots. Newer Bose speakers set up in the Bose Music app can be added as AirPlay or Chromecast speakers instead."),
  B("bang", "Bang & Olufsen", "media", "steps", "bang_olufsen", "For Beolab, Beosound and Beoconnect products set up in the Bang & Olufsen app (2020 and later). Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("devialet", "Devialet", "media", "steps", "devialet", "For Phantom speakers and the Dione soundbar. Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("wiim", "WiiM", "media", "steps", "wiim", "WiiM streamers and amplifiers are usually found by themselves. Its address is shown in its own network settings: four numbers with dots."),
  B("linkplay", "Arylic, Audio Pro and other Linkplay players", "media", "steps", "linkplay", "Many streaming amplifiers and speakers share the same insides: Arylic, Audio Pro, iEAST, Dayton Audio, GGMM and others. Usually found by itself. Its address is shown in its own network settings: four numbers with dots."),
  B("russound", "Russound", "media", "steps", "russound_rio", "For Russound whole-home audio controllers (MCA and MBX series) wired to your home network. Its address is shown in its own network settings: four numbers with dots."),
  B("lg_soundbar", "LG soundbars", "media", "steps", "lg_soundbar", "The soundbar must be on your Wi-Fi, set up in the LG app. Its address is shown in its own network settings: four numbers with dots."),
  B("dlna", "Other network TVs and speakers", "media", "steps", "dlna_dmr", "Many TVs, receivers and speakers that Vincent has no name for still answer a shared language called DLNA. The hub searches for them; what it can do with one varies, and is often only play, pause and volume."),
  // Climate
  M(B("nest_thermostat", "Google Nest thermostat", "climate", "matter", undefined, "Only two Nest thermostats can be added today: the Nest Thermostat (2020, the mirrored one) and the Nest Learning Thermostat 4th generation. The 3rd generation and earlier, and the Nest Thermostat E, have no code to give and cannot be added yet. If Google Home shows no Linked Matter apps & services for yours, it is one of those.", "matter"),
    "For the Nest Thermostat (2020) and the Nest Learning Thermostat 4th generation. Older Nest thermostats cannot be added yet.",
    FROM_GOOGLE),
  B("nest", "Google Nest cameras and doorbells", "security", "link", "nest", "Nest cameras and doorbells need an account link on Google's website."),
  B("ecobee", "ecobee", "climate", "steps", "homekit_controller", "ecobee thermostats are added with their HomeKit code. On the thermostat: Menu, Settings, HomeKit, and turn on pairing to show the code. Only if it is already in Apple Home: remove it there first, or use Menu, Settings, Reset, Reset HomeKit."),
  B("honeywell", "Honeywell Total Connect Comfort", "climate", "steps", "honeywell", "You will be asked for your Total Connect Comfort sign-in. Check first: if you can see your thermostat at mytotalconnectcomfort.com, it will work. If your thermostat is in the Resideo app instead, this sign-in will not work."),
  B("sensibo", "Sensibo", "climate", "steps", "sensibo", "You will be asked for an API key. Sign in at home.sensibo.com/me/api and create one there."),
  B("tado", "tado°", "climate", "link", "tado", "tado° cannot be added today. The older range needs a sign-in on tado's website, and tado limits how often other apps may check it. The current tado X range uses Thread instead."),
  // Security
  B("ring", "Ring", "security", "steps", "ring", "You will be asked for your Ring sign-in and the code Ring sends you (by text, or from your authenticator app). Doorbells, cameras, chimes and the intercom are supported; Ring Alarm is not. Limited by manufacturer: Ring works through Ring's own service, so it needs the internet."),
  B("reolink", "Reolink", "security", "steps", "reolink", "The hub usually finds the camera by itself. Enter the camera's or recorder's own sign-in (not the Reolink app account); it must be an admin user. If it will not connect, open the Reolink app and switch on HTTP or HTTPS in the camera's network settings."),
  B("unifi", "UniFi Protect", "security", "steps", "unifiprotect", "Open the console by its address in a browser (not unifi.ui.com) and make a local user for the hub; a Ubiquiti cloud login will not work. Then in UniFi Protect, under Integrations, make an API key. Enter the address, the local user and the key here."),
  B("onvif", "Other cameras (ONVIF)", "security", "steps", "onvif", "Most network cameras speak ONVIF once it is switched on in the camera's own settings. You will need its address and sign-in."),
  B("eufy_camera", "eufy cameras", "security", "steps", "generic", "For eufy cameras that can send a stream. First, in the eufy app: tap the camera, then the gear, then Storage, NAS (RTSP Stream). Switch it on and set recording to Continuous. The app then shows an address starting rtsp:// with a username and a password; you type those three here. Doorbells and most battery cameras have no such setting and work only in the eufy app."),
  B("camera_stream", "Other cameras (stream address)", "security", "steps", "generic", "For any camera that gives a stream address starting rtsp://. Its own app or manual shows the address, and a username and password if it has them."),
  M(B("eufy", "eufy", "security", "matter", undefined, "For eufy's Wi-Fi smart locks (FamiLock S3 and S3 Max). For eufy cameras, choose eufy cameras from the brand list.", "matter"),
    "For eufy FamiLock S3 and S3 Max. eufy's other Matter locks use Thread, which this hub cannot reach yet. A lock connected through a eufy HomeBase 3 cannot use Matter.",
    ["Open the eufy app, tap the lock, then Settings.", "Tap Work with Matter, then Connect to Third-party Ecosystem.", "Tap Start Pairing. The lock's light blinks blue.", "Scan the Matter code on the lock or its box here.", FIRST_APP]),
  B("blink", "Blink", "security", "steps", "blink", "You will be asked for your Blink sign-in. If Blink texts or emails a code, enter it. If Blink instead emails asking you to allow access, approve it and leave the code box empty. Live video is not available: you get still pictures, motion alerts and arming. Motion is only reported while the system is armed."),
  B("schlage", "Schlage", "security", "steps", "schlage", "You will be asked for your Schlage Home sign-in."),
  B("yale", "Yale and August", "security", "link", "yale", "Yale and August need an account link on their website."),
  B("arlo", "Arlo", "security", "none", undefined, "Arlo cameras work only through the Arlo app and account. Limited by manufacturer."),
  B("simplisafe", "SimpliSafe", "security", "link", "simplisafe", "SimpliSafe cannot be added from Vincent today. Keep using the SimpliSafe app for now."),
  // By code
  M(B("from_apple", "Already in Apple Home", "other", "matter", undefined, "A device you already use in Apple Home can be shared with Vincent, and keeps working in Apple Home too.", "matter"),
    "For devices added to Apple Home with a Matter code. If there is no Turn On Pairing Mode row, the device cannot be shared this way.", FROM_APPLE),
  M(B("from_google", "Already in Google Home", "other", "matter", undefined, "A device you already use in Google Home can be shared with Vincent, and keeps working in Google Home too.", "matter"),
    "For Matter devices in Google Home.", FROM_GOOGLE),
  M(B("from_alexa", "Already in Alexa", "other", "matter", undefined, "A light, plug or lock you already use with Alexa can be shared with Vincent, and keeps working with Alexa too. For Echo speakers themselves, choose Amazon Echo (Alexa).", "matter"),
    "For lights, plugs and locks that were added to Alexa with a Matter code. Devices linked through a skill have no such option, and an Echo speaker itself is added another way: choose Amazon Echo (Alexa) from the brand list.", FROM_ALEXA),
  M(B("from_smartthings", "Already in SmartThings", "other", "matter", undefined, "A Matter device in SmartThings can be shared with Vincent.", "matter"),
    "For Matter devices in SmartThings.", FROM_SMARTTHINGS),
  B("tuya", "Tuya and Smart Life", "other", "steps", "tuya", "For anything you already use in the Smart Life or Tuya Smart app, whatever name is on the box: many plugs, bulbs, light strips, switches and heaters sold under smaller names work through Tuya. You will need that app on your phone to approve the sign-in. If a device is not in that app yet, add it there first."),
  B("matter", "Anything with a Matter code", "other", "matter", undefined, "Matter is a shared language many newer bulbs, plugs, locks and sensors speak. The device must already be on your Wi-Fi, through its maker's app or another smart-home app. Ask that app for a Matter code to share it."),
  B("homekit", "Anything with a HomeKit code", "other", "steps", "homekit_controller", "The device must not be in Apple Home at the same time: remove it there first. Then it appears here to be paired with the eight-digit code on its label."),
];

/**
 * What the household should expect before they start: what adding takes, and whether their model can be added at all.
 * [needs], [needs, fit, models] or [needs, fit, models, how]. `how` is anything to know about adding it that `models` has not said.
 * A brand not listed here is described from how it is added.
 */
const EXPECT: Record<string, [string, Brand["fit"]?, string?, string?]> = {
  hue: ["Requires a Hue Bridge, and pressing the button on it"],
  govee: ["Requires LAN Control switched on in the Govee app", "some", "Many Govee Wi-Fi lights work, but not all: only those where the Govee app shows a LAN Control switch. Bluetooth-only lights do not. Newer lights with the Matter badge can be added with their code.", "In the Govee app, open the light, tap the gear and turn on LAN Control, then search. If the switch is missing, unplug the light, plug it back in and wait up to 30 minutes."],
  lifx: ["Nothing to type: the hub searches"],
  kasa: ["Tapo and newer Kasa devices require your TP-Link email and password"],
  wled: ["Usually found by itself. If not, the strip's address from the WLED app"],
  nanoleaf: ["Requires holding the power button on the panels", "some", "The wall panels: Light Panels, Canvas, Shapes, Elements and Lines. Essentials bulbs and strips use Thread, which this hub does not have. Newer Nanoleaf Wi-Fi lights with the Matter badge are added with their Matter code instead.", "To add the panels, hold the power button on the controller for 5 to 7 seconds until its lights start flashing, then continue within 30 seconds."],
  yeelight: ["Requires LAN Control switched on in the Yeelight app"],
  lutron: ["Requires pressing the button on the Smart Hub"],
  shelly: ["Usually found by itself. If not, the device's address from the Shelly app"],
  wiz: ["Usually nothing to type: the hub searches"],
  elgato: ["Usually found by itself. If not, the light's address"],
  wemo: ["Nothing to type: the hub searches", "some", "Only Wemo plugs, switches and dimmers that are already on your Wi-Fi. Belkin closed the Wemo app on January 31, 2026, so a new or reset Wemo device can no longer be set up. The Thread models cannot be added."],
  meross: ["Requires the code printed on the device", "some", "Meross models with the Matter badge, and models with an Apple Home code (a small house beside eight digits on the sticker), which must be removed from Apple Home first. Meross devices with neither are not compatible.", "Do not delete the device from the Meross app afterwards: that resets it."],
  aqara: ["Requires an Aqara hub and a code from the Aqara app", "some", "Works through an Aqara hub: M3, M200, M100, M2, M1S, E1, or the camera hubs G3, G5 Pro and G410. Sensors and switches on their own are not compatible.", "Update the hub and the Aqara Home app first."],
  switchbot: ["Requires a code from the SwitchBot app, and usually a SwitchBot hub", "some", "Works through a SwitchBot Hub 2, Hub 3, AI Hub or a Hub Mini marked Matter Enabled. Some newer Wi-Fi products need no hub: the Air Purifier, robot vacuums, Floor Lamp, LED Strip Light 3 and the Lock Pro marked Matter Enabled. The original Hub Mini does not work.", "Each hub passes on a limited number of devices: Hub Mini 4, Hub 2 8, Hub 3 and AI Hub 30."],
  leviton: ["Requires a code from the My Leviton app", "some", "Decora Smart Wi-Fi 2nd generation (models starting D2) and the newer models starting D3. Not every D2 model has Matter yet. First-generation Wi-Fi and HomeKit models are not compatible.", "Leviton's Matter update removes the device from Apple Home; it has to be added there again with the Matter code."],
  amazon_echo: ["Requires your Amazon username and password"],
  amazon_plug: ["Requires the Matter code from the plug's box", "some", "The Amazon Basics Smart Plug with the Matter badge can be added with the code in its box. The original Amazon Smart Plug has no badge, works only through Alexa and cannot be added."],
  wyze: ["Works only in the Wyze app", "no", "Wyze devices work only in the Wyze app. Wyze gives no way in for other apps."],
  smartthings: ["Needs an account link with Samsung", "no", "From December 15, 2026 Samsung requires a paid SmartThings plan to link other apps, and Vincent does not offer that link yet. Devices in SmartThings that speak Matter can be added without it: choose Already in SmartThings."],
  sonos: ["Nothing to type: the hub searches"],
  apple_tv: ["Usually found by itself. Requires a code shown on the TV"],
  roku: ["Usually found by itself. If not, the Roku's address from its Settings"],
  samsung_tv: ["Usually found by itself. Requires pressing Allow on the TV"],
  lg_tv: ["Usually found by itself. Requires a yes on the TV"],
  cast: ["Nothing to type: the hub searches"],
  android_tv: ["Usually found by itself. Requires a code shown on the TV"],
  denon: ["Nothing to type, or the receiver's address"],
  yamaha: ["Usually found by itself. If not, the receiver's address"],
  heos: ["Usually found by itself. If not, one speaker's address"],
  bluesound: ["Usually found by itself. If not, the player's address"],
  sony_tv: ["Requires a code shown on the TV"],
  vizio: ["Usually found by itself. A TV shows a code"],
  philips_tv: ["Requires the TV's address, and often a code shown on the TV"],
  panasonic_tv: ["Requires the TV's address and a code shown on the TV"],
  lg_old: ["Requires the TV's address and a code shown on the TV"],
  fire_tv: ["Requires a setting switched on at the Fire TV, and its address"],
  directv: ["Usually found by itself. If not, the receiver's address"],
  ps4: ["Requires the Second Screen app and a code from the console"],
  epson: ["Requires the projector's address"],
  jvc: ["Requires the projector's address"],
  pjlink: ["Requires the projector's address"],
  madvr: ["Requires its address"],
  onkyo: ["Usually found by itself. If not, the receiver's address"],
  sony_audio: ["Usually found by itself. If not, its address"],
  anthem: ["Requires the receiver's address"],
  arcam: ["Usually found by itself. If not, the receiver's address"],
  cambridge: ["Usually found by itself. If not, its address"],
  lyngdorf: ["Usually found by itself. If not, its address"],
  bose: ["Usually found by itself. If not, the speaker's address"],
  bang: ["Usually found by itself. If not, its address"],
  devialet: ["Usually found by itself. If not, its address"],
  wiim: ["Usually found by itself. If not, its address"],
  linkplay: ["Usually found by itself. If not, its address"],
  russound: ["Requires the controller's address"],
  lg_soundbar: ["Requires the soundbar's address"],
  dlna: ["Nothing to type: the hub searches"],
  nest_thermostat: ["Requires a code from the Google Home app", "some", "Only the Nest Thermostat (2020) and the Nest Learning Thermostat 4th generation. The 3rd generation and the Thermostat E are not compatible yet. The 1st and 2nd generation are no longer supported by Google and will not be.", "If Google Home shows no Linked Matter apps & services for yours, it is one that cannot be added."],
  nest: ["Needs an account link on Google's website", "no", "Nest cameras and doorbells need an account link on Google's website, which Vincent does not offer yet. Nest thermostats can be added: the Nest Thermostat (2020) and the Learning Thermostat 4th generation."],
  ecobee: ["Requires the HomeKit code from the thermostat's own menu"],
  honeywell: ["Requires your Total Connect Comfort username and password", "some", "Thermostats you control in the Total Connect Comfort app (US accounts). Thermostats set up in the Resideo app (T5, T6 Pro, T9, T10) do not work this way. The newer X2S is added with its Matter code instead.", "Check first: if you can see your thermostat at mytotalconnectcomfort.com, it will work."],
  sensibo: ["Requires an API key from Sensibo's website"],
  tado: ["Needs an account link on tado's website", "no", "The current tado X range uses Thread, which this hub does not have. Older tado (V3+ and earlier) needs a sign-in on tado's website that Vincent does not offer yet."],
  tuya: ["Requires the Smart Life or Tuya Smart app on your phone", "yes", "Everything in your Smart Life or Tuya Smart account. Brands that use it include Gosund, Teckin, Treatlife, Aubess, Moes, Zemismart, Nedis, LSC, Globe, Geeni and Merkury, and many more with no name you would know.", "Tuya works through Tuya's own service, so these devices need the internet."],
  ring: ["Requires your Ring email and password, and a sign-in code from Ring", "some", "Doorbells, cameras, chimes and the intercom. Ring Alarm and its sensors are not compatible.", "Ring works through Ring's own service, so it needs the internet."],
  reolink: ["Requires the camera's own username and password", "some", "Plug-in and PoE cameras, video doorbells, recorders and Home Hubs. Battery cameras (Argus, Altas) should be added through a Reolink Home Hub or recorder. Cameras that use a SIM card cannot be added.", "The hub usually finds the camera by itself. Use the camera's or recorder's own sign-in (not the Reolink app account); it must be an admin user. If it will not connect, switch on HTTP or HTTPS in the camera's network settings in the Reolink app."],
  unifi: ["Requires the console's address, a local user, and an API key made on the console"],
  onvif: ["Requires the camera's address, username and password"],
  eufy_camera: ["Requires RTSP switched on in the eufy app", "some", "Mostly plug-in cameras (Indoor Cam models, Floodlight Cam E340 and similar). The test is simple: if the eufy app shows a NAS (RTSP) setting for the camera, it can be added. Doorbells and most battery cameras cannot.", "First, in the eufy app: tap the camera, then the gear, then Storage, NAS (RTSP Stream). Switch it on and set recording to Continuous. The app then shows an address starting rtsp:// with a username and a password; you type those three here."],
  camera_stream: ["Requires the camera's stream address"],
  eufy: ["Requires a Matter code from the eufy app", "some", "Only the FamiLock S3 and S3 Max. Other eufy locks are not compatible yet.", "For eufy cameras, choose eufy cameras from the brand list."],
  blink: ["Requires your Blink username and password, and a code Blink sends you", "some", "Still pictures, motion alerts and arming only. Blink gives other apps no live video.", "If Blink texts or emails a code, enter it. If Blink instead emails asking you to allow access, approve it and leave the code box empty. Motion is only reported while the system is armed."],
  schlage: ["Requires your Schlage Home email and password", "some", "Schlage Encode, Encode Lever and Encode Plus Wi-Fi locks. The newer Sense Pro and Arrive are untested. Schlage Connect and the old Schlage Sense are not compatible."],
  yale: ["Needs an account link on Yale's website", "no", "Yale and August need an account link on their website, which Vincent does not offer yet. Yale's Matter locks use Thread, which this hub does not have; they can only be added if another maker's Thread device in the home (a Google Nest Hub, Apple TV or HomePod) shares the lock on."],
  arlo: ["Works only in the Arlo app", "no", "Arlo cameras work only in the Arlo app. Arlo has no Matter support and no link for hubs like this one."],
  simplisafe: ["Needs an account link on SimpliSafe's website", "no", "Keep using the SimpliSafe app for now."],
  from_apple: ["Requires a code from the Apple Home app"],
  from_google: ["Requires a code from the Google Home app"],
  from_alexa: ["Requires a code from the Alexa app"],
  from_smartthings: ["Requires a code from the SmartThings app"],
  matter: ["Requires the device's Matter code"],
  homekit: ["Requires the eight-digit HomeKit code on the device"],
};
const BY_HOW: Record<Brand["how"], [string, Brand["fit"]]> = {
  search: ["Nothing to type: the hub searches", "yes"], steps: ["Requires a few details from the maker's app", "yes"], matter: ["Requires a Matter code", "yes"],
  link: ["Needs an account link on the maker's website", "no"], none: ["Works only in the maker's own app", "no"],
};

export const brandList = (): Brand[] => BRANDS.map(({ driver: _driver, ...b }) => {
  const [needs, fit, models, how] = EXPECT[b.id] ?? [];
  const f = fit ?? BY_HOW[b.how][1];
  // One paragraph for the brand's page: everything that works is told by its tips; anything narrower by which models, then how.
  const about = f === "yes" || !models ? b.tips : [models, how].filter(Boolean).join(" ");
  return { ...b, needs: needs ?? BY_HOW[b.how][0], fit: f, about, ...(models ? { models } : {}) };
});
export const brand = (id: string): Entry | undefined => BRANDS.find((b) => b.id === id);
