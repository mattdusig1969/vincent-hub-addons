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

export const BRANDS: Entry[] = [
  // Lights
  B("hue", "Philips Hue", "lights", "steps", "hue", "The Hue Bridge must be plugged into your router. You will be asked to press the button on top of the bridge."),
  B("govee", "Govee", "lights", "search", "govee_light_local", "Switch the light on. In the Govee app, open the light's settings and turn on LAN Control. Newer Govee lights can also be added with a Matter code.", "matter"),
  B("lifx", "LIFX", "lights", "search", "lifx", "Switch the light on at the wall. It must already be set up in the LIFX app and on your Wi-Fi."),
  B("kasa", "TP-Link Kasa and Tapo", "lights", "steps", "tplink", "Leave the address empty to search. Newer devices ask for your TP-Link account so the hub can talk to them directly."),
  B("wled", "WLED", "lights", "steps", "wled", "Enter the strip's address, shown in the WLED app."),
  B("nanoleaf", "Nanoleaf", "lights", "steps", "nanoleaf", "You will be asked to hold the power button on the panels for a few seconds."),
  B("yeelight", "Yeelight", "lights", "steps", "yeelight", "Turn on LAN Control for the light in the Yeelight app first."),
  B("lutron", "Lutron Caséta", "lights", "steps", "lutron_caseta", "The Smart Hub must be plugged into your router. You will be asked to press the small button on its back."),
  B("shelly", "Shelly", "other", "steps", "shelly", "Enter the device's address, shown in the Shelly app."),
  B("wiz", "WiZ", "lights", "steps", "wiz", "Switch the light on. In the WiZ app, turn on Allow Local Communication."),
  B("elgato", "Elgato Key Light", "lights", "steps", "elgato", "Enter the light's address."),
  // Plugs and switches
  B("wemo", "Belkin Wemo", "other", "search", "wemo", "The plug must be set up in the Wemo app and on your Wi-Fi."),
  B("meross", "Meross", "other", "matter", undefined, "Meross gives no way to control its plugs on the home network except Matter. Newer Meross plugs have a Matter code on the device or in the Meross app (Device, then Matter). Older ones cannot be added.", "matter"),
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
  B("nest", "Google Nest", "climate", "link", "nest", "Nest needs an account link on Google's website."),
  B("ecobee", "ecobee", "climate", "steps", "homekit_controller", "ecobee thermostats are added with their HomeKit code. On the thermostat: Menu, Settings, Reset, Reset HomeKit, then find the code under Menu, Settings, HomeKit."),
  B("honeywell", "Honeywell Total Connect Comfort", "climate", "steps", "honeywell", "You will be asked for your Total Connect Comfort sign-in."),
  B("sensibo", "Sensibo", "climate", "steps", "sensibo", "You will be asked for an API key, made on Sensibo's website under your account."),
  B("tado", "tado°", "climate", "link", "tado", "tado° needs an account link on tado's website."),
  // Security
  B("ring", "Ring", "security", "steps", "ring", "You will be asked for your Ring sign-in and the code Ring texts you. Limited by manufacturer: Ring is controlled through Ring's own service."),
  B("reolink", "Reolink", "security", "steps", "reolink", "Enter the camera's or recorder's address and its own sign-in (not the Reolink app account)."),
  B("unifi", "UniFi Protect", "security", "steps", "unifiprotect", "Enter the console's address and a local user made for the hub."),
  B("onvif", "Other cameras (ONVIF)", "security", "steps", "onvif", "Most network cameras speak ONVIF once it is switched on in the camera's own settings. You will need its address and sign-in."),
  B("blink", "Blink", "security", "steps", "blink", "You will be asked for your Blink sign-in and the code Blink sends you."),
  B("schlage", "Schlage", "security", "steps", "schlage", "You will be asked for your Schlage Home sign-in."),
  B("yale", "Yale and August", "security", "link", "yale", "Yale and August need an account link on their website."),
  B("arlo", "Arlo", "security", "none", undefined, "Arlo cameras work only through the Arlo app and account. Limited by manufacturer."),
  B("simplisafe", "SimpliSafe", "security", "link", "simplisafe", "SimpliSafe needs an account link on its website."),
  // By code
  B("matter", "Anything with a Matter code", "other", "matter", undefined, "Matter is a shared language many newer bulbs, plugs, locks and sensors speak. The device must already be on your Wi-Fi, through its maker's app or another smart-home app. Ask that app for a Matter code to share it."),
  B("homekit", "Anything with a HomeKit code", "other", "steps", "homekit_controller", "The device must not be in Apple Home at the same time: remove it there first. Then it appears here to be paired with the eight-digit code on its label."),
];

export const brandList = (): Brand[] => BRANDS.map(({ driver: _driver, ...b }) => b);
export const brand = (id: string): Entry | undefined => BRANDS.find((b) => b.id === id);
