// SPDX-License-Identifier: AGPL-3.0-only
//! `terminal config`: the person's Ghostty config on this computer as the terminal pane applies it, read here with no
//! host, the way packages/collect/src/ghostty-config.ts reads it: config.ghostty then config under XDG, then the same
//! pair in the Mac's Application Support, each followed by the files it includes, the last theme line resolved against
//! the config's themes folder and the bundled ones, and only the keys the pane honours kept. Its text is the lines
//! `terminalConfigLines` prints.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{input, Answer, Refused, Tool};
use crate::host::Host;
use crate::js;
use crate::record;

const NAME: &str = "terminal_config";

pub const TOOL: Tool =
    Tool { name: NAME, listed: include_str!("../../record/tools/terminal_config.json"), call: |host, args| Box::pin(call(host, args)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
}

/// The config's fields as the held schema lists them; the answer itself is written in the order the TypeScript
/// reader sets them, which is the order the files set them, so it is laid out by `Config::json` rather than derived.
#[cfg(test)]
#[derive(schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct Out {
    files: Vec<String>,
    font_family: Vec<String>,
    font_size: Option<f64>,
    theme: Option<String>,
    background: Option<Value>,
    foreground: Option<Value>,
    palette: Vec<Option<Value>>,
    selection_background: Option<Value>,
    cursor_color: Option<Value>,
    cursor_style: Option<String>,
    cursor_style_blink: Option<bool>,
    window_padding_x: Option<Value>,
    window_padding_y: Option<Value>,
    background_opacity: Option<f64>,
    background_blur: Option<u64>,
}

const MAC_APP_SUPPORT: &str = "Library/Application Support/com.mitchellh.ghostty";
const MAC_BUNDLED_THEMES: &str = "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";
const LINUX_SHARED_THEMES: [&str; 2] = ["/usr/local/share/ghostty/themes", "/usr/share/ghostty/themes"];
const DEFAULT_BLUR: f64 = 20.0;
const CURSOR_STYLES: [&str; 4] = ["block", "bar", "underline", "block_hollow"];

#[derive(Clone, Copy, PartialEq)]
struct Rgb(u8, u8, u8);

impl Rgb {
    fn json(self) -> String {
        format!(r#"{{"r":{},"g":{},"b":{}}}"#, self.0, self.1, self.2)
    }
    fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }
}

/// One key the pane honours, as the draft holds it once a file has set it.
#[derive(Clone, Copy, PartialEq)]
enum Key {
    FontSize,
    Background,
    Foreground,
    SelectionBackground,
    CursorColor,
    CursorStyle,
    CursorStyleBlink,
    WindowPaddingX,
    WindowPaddingY,
    BackgroundOpacity,
    BackgroundBlur,
}

/// The draft the directives apply over, with the order its keys were first set in, which is the order a JavaScript
/// object writes them.
#[derive(Default)]
struct Config {
    font_family: Vec<String>,
    palette: [Option<Rgb>; 16],
    set: Vec<Key>,
    font_size: f64,
    background: Option<Rgb>,
    foreground: Option<Rgb>,
    selection_background: Option<Rgb>,
    cursor_color: Option<Rgb>,
    cursor_style: String,
    cursor_style_blink: bool,
    window_padding_x: (f64, f64),
    window_padding_y: (f64, f64),
    background_opacity: f64,
    background_blur: f64,
}

impl Config {
    fn mark(&mut self, key: Key) {
        if !self.set.contains(&key) {
            self.set.push(key);
        }
    }

    fn has(&self, key: Key) -> bool {
        self.set.contains(&key)
    }

    /// `apply`: a value that does not parse leaves its key as it was.
    fn apply(&mut self, key: &str, value: &str) {
        match key {
            "font-family" => {
                if value.is_empty() {
                    self.font_family.clear();
                } else {
                    self.font_family.push(value.to_owned());
                }
            }
            "font-size" => {
                if let Some(n) = finite(value).filter(|n| *n > 0.0) {
                    self.font_size = n;
                    self.mark(Key::FontSize);
                }
            }
            "background" | "foreground" | "selection-background" | "cursor-color" => {
                let Some(color) = hex_color(value) else { return };
                let (slot, key) = match key {
                    "background" => (&mut self.background, Key::Background),
                    "foreground" => (&mut self.foreground, Key::Foreground),
                    "selection-background" => (&mut self.selection_background, Key::SelectionBackground),
                    _ => (&mut self.cursor_color, Key::CursorColor),
                };
                *slot = Some(color);
                self.mark(key);
            }
            "palette" => {
                if let Some((index, color)) = palette_entry(value) {
                    self.palette[index] = Some(color);
                }
            }
            "cursor-style" => {
                if CURSOR_STYLES.contains(&value) {
                    self.cursor_style = value.to_owned();
                    self.mark(Key::CursorStyle);
                }
            }
            "cursor-style-blink" => match value {
                "true" | "false" => {
                    self.cursor_style_blink = value == "true";
                    self.mark(Key::CursorStyleBlink);
                }
                "" => self.set.retain(|k| *k != Key::CursorStyleBlink),
                _ => {}
            },
            "window-padding-x" | "window-padding-y" => {
                let Some(pair) = padding(value) else { return };
                if key == "window-padding-x" {
                    self.window_padding_x = pair;
                    self.mark(Key::WindowPaddingX);
                } else {
                    self.window_padding_y = pair;
                    self.mark(Key::WindowPaddingY);
                }
            }
            "background-opacity" => {
                if let Some(n) = finite(value) {
                    self.background_opacity = n.clamp(0.0, 1.0);
                    self.mark(Key::BackgroundOpacity);
                }
            }
            "background-blur" | "background-blur-radius" => {
                if let Some(n) = blur(value) {
                    self.background_blur = n;
                    self.mark(Key::BackgroundBlur);
                }
            }
            _ => {}
        }
    }

    /// The config as `{ files, ...draft, theme }` writes it.
    fn json(&self, files: &[String], theme: Option<&str>) -> String {
        let string = |s: &str| serde_json::to_string(s).unwrap_or_default();
        let list = |items: &[String]| items.iter().map(|s| string(s)).collect::<Vec<_>>().join(",");
        let palette = self.palette.iter().map(|c| c.map_or_else(|| "null".to_owned(), Rgb::json)).collect::<Vec<_>>().join(",");
        let mut fields = vec![
            format!(r#""files":[{}]"#, list(files)),
            format!(r#""fontFamily":[{}]"#, list(&self.font_family)),
            format!(r#""palette":[{palette}]"#),
        ];
        let color = |c: Option<Rgb>| c.map_or_else(|| "null".to_owned(), Rgb::json);
        for key in &self.set {
            fields.push(match key {
                Key::FontSize => format!(r#""fontSize":{}"#, js::number(self.font_size)),
                Key::Background => format!(r#""background":{}"#, color(self.background)),
                Key::Foreground => format!(r#""foreground":{}"#, color(self.foreground)),
                Key::SelectionBackground => format!(r#""selectionBackground":{}"#, color(self.selection_background)),
                Key::CursorColor => format!(r#""cursorColor":{}"#, color(self.cursor_color)),
                Key::CursorStyle => format!(r#""cursorStyle":{}"#, string(&self.cursor_style)),
                Key::CursorStyleBlink => format!(r#""cursorStyleBlink":{}"#, self.cursor_style_blink),
                Key::WindowPaddingX => format!(
                    r#""windowPaddingX":{{"left":{},"right":{}}}"#,
                    js::number(self.window_padding_x.0),
                    js::number(self.window_padding_x.1)
                ),
                Key::WindowPaddingY => format!(
                    r#""windowPaddingY":{{"top":{},"bottom":{}}}"#,
                    js::number(self.window_padding_y.0),
                    js::number(self.window_padding_y.1)
                ),
                Key::BackgroundOpacity => format!(r#""backgroundOpacity":{}"#, js::number(self.background_opacity)),
                Key::BackgroundBlur => format!(r#""backgroundBlur":{}"#, js::number(self.background_blur)),
            });
        }
        if let Some(theme) = theme {
            fields.push(format!(r#""theme":{}"#, string(theme)));
        }
        format!("{{{}}}", fields.join(","))
    }

    /// `terminalConfigLines`.
    fn lines(&self, files: &[String], theme: Option<&str>, none: &str) -> Vec<String> {
        if files.is_empty() {
            return vec![none.to_owned()];
        }
        let set = self.palette.iter().filter(|c| c.is_some()).count();
        let pair = |a: f64, b: f64| if a == b { js::number(a) } else { format!("{},{}", js::number(a), js::number(b)) };
        let on = |key: Key, value: String| self.has(key).then_some(value);
        let hex = |c: Option<Rgb>| c.map(Rgb::hex).unwrap_or_default();
        let rows: [(&str, Option<String>); 14] = [
            ("font-family", (!self.font_family.is_empty()).then(|| self.font_family.join(", "))),
            ("font-size", on(Key::FontSize, js::number(self.font_size))),
            ("theme", theme.map(str::to_owned)),
            ("background", on(Key::Background, hex(self.background))),
            ("foreground", on(Key::Foreground, hex(self.foreground))),
            ("palette", (set > 0).then(|| format!("{set} of 16 colors"))),
            ("selection-background", on(Key::SelectionBackground, hex(self.selection_background))),
            ("cursor-color", on(Key::CursorColor, hex(self.cursor_color))),
            ("cursor-style", on(Key::CursorStyle, self.cursor_style.clone())),
            ("cursor-style-blink", on(Key::CursorStyleBlink, self.cursor_style_blink.to_string())),
            ("window-padding-x", on(Key::WindowPaddingX, pair(self.window_padding_x.0, self.window_padding_x.1))),
            ("window-padding-y", on(Key::WindowPaddingY, pair(self.window_padding_y.0, self.window_padding_y.1))),
            ("background-opacity", on(Key::BackgroundOpacity, js::number(self.background_opacity))),
            ("background-blur", on(Key::BackgroundBlur, js::number(self.background_blur))),
        ];
        let mut out = vec![format!("Read {}", files.join(", "))];
        out.extend(rows.into_iter().filter_map(|(key, value)| Some(format!("{key} = {}", value?))));
        out
    }
}

/// `/^"(.*)"$/`, whose dot takes no line terminator.
fn unquote(value: &str) -> &str {
    match value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        Some(inner) if !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) => inner,
        _ => value,
    }
}

/// `parseGhosttyDirectives`: the key = value lines of one file, in order and with repeats.
fn directives(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let line = js::trim(raw.strip_prefix('\u{feff}').unwrap_or(raw));
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(at) = line.find('=') else { continue };
        let key = js::trim(&line[..at]);
        if key.is_empty() {
            continue;
        }
        out.push((key.to_owned(), unquote(js::trim(&line[at + 1..])).to_owned()));
    }
    out
}

/// `Number(text)`: JavaScript's reading of a string as a number, NaN where it reads none.
fn js_number(text: &str) -> f64 {
    let text = js::trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)) {
                digits.chars().fold(0.0, |n, c| n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)))
            } else {
                f64::NAN
            };
        }
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let digits = mantissa.replace('.', "");
    let decimal = mantissa.matches('.').count() <= 1 && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
    });
    if decimal && exponent_ok {
        text.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn finite(value: &str) -> Option<f64> {
    let n = js_number(value);
    (!js::trim(value).is_empty() && n.is_finite()).then_some(n)
}

fn hex_color(value: &str) -> Option<Rgb> {
    let hex = js::trim(value);
    let hex = hex.strip_prefix('#').unwrap_or(hex);
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some(Rgb(channel(0)?, channel(2)?, channel(4)?))
}

/// `N=COLOR` with N in decimal, 0x, 0o or 0b; only the first sixteen slots are the pane's.
fn palette_entry(value: &str) -> Option<(usize, Rgb)> {
    let at = value.find('=')?;
    let index = js_number(&value[..at]);
    let color = hex_color(&value[at + 1..])?;
    (index.fract() == 0.0 && (0.0..=15.0).contains(&index)).then_some((index as usize, color))
}

/// One or two non-negative numbers, comma separated; one value sets both sides.
fn padding(value: &str) -> Option<(f64, f64)> {
    let parts: Vec<Option<f64>> = value.split(',').map(finite).collect();
    let a = parts.first().copied().flatten().filter(|a| *a >= 0.0)?;
    match parts.len() {
        1 => Some((a, a)),
        2 => Some((a, parts[1].filter(|b| *b >= 0.0)?)),
        _ => None,
    }
}

fn blur(value: &str) -> Option<f64> {
    let word = js::trim(value).to_lowercase();
    if word == "false" {
        return Some(0.0);
    }
    if word == "true" || word.starts_with("macos-glass-") {
        return Some(DEFAULT_BLUR);
    }
    finite(&word).filter(|n| n.fract() == 0.0 && *n >= 0.0)
}

/// `themeFor`: the one name, or the side of a light:/dark: pair the scheme names.
fn theme_for(value: &str, scheme: &str) -> String {
    let mut sides: Vec<(String, String)> = Vec::new();
    for part in value.split(',') {
        if let Some(at) = part.find(':').filter(|at| *at > 0) {
            let (side, name) = (js::trim(&part[..at]).to_owned(), js::trim(&part[at + 1..]).to_owned());
            sides.retain(|(s, _)| *s != side);
            sides.push((side, name));
        }
    }
    match sides.iter().find(|(side, _)| side == scheme) {
        Some((_, name)) => name.clone(),
        None if sides.is_empty() => js::trim(value).to_owned(),
        None => String::new(),
    }
}

fn read_text(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Ghostty normalises a path lexically before comparing it, so an include naming its own file through .. is a cycle.
fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    format!("/{}", out.join("/"))
}

fn dir_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) if at > 0 => &path[..at],
        _ => "/",
    }
}

fn expand(home: &str, path: &str) -> String {
    if path == "~" {
        return home.to_owned();
    }
    path.strip_prefix("~/").map_or_else(|| path.to_owned(), |rest| format!("{home}/{rest}"))
}

struct Reader {
    home: String,
    xdg: String,
    seen: HashSet<String>,
    files: Vec<String>,
    own: Vec<(String, String)>,
}

impl Reader {
    /// One config file and, after it, the files it includes, each once.
    fn load(&mut self, path: &str) {
        let own = normalize(path);
        if self.seen.contains(&own) {
            return;
        }
        let Some(text) = read_text(&own) else { return };
        self.seen.insert(own.clone());
        self.files.push(own.clone());
        let read = directives(&text);
        let mut includes = Vec::new();
        for (key, value) in &read {
            if key != "config-file" {
                continue;
            }
            if value.is_empty() {
                includes.clear();
                continue;
            }
            let optional = value.starts_with('?');
            let path = unquote(if optional { &value[1..] } else { value });
            if path.is_empty() {
                continue;
            }
            let expanded = expand(&self.home, path);
            includes.push(if expanded.starts_with('/') { expanded } else { format!("{}/{expanded}", dir_of(&own)) });
        }
        self.own.extend(read);
        for include in includes {
            self.load(&include);
        }
    }
}

/// `readGhosttyConfig`: the config as the pane applies it, and the files it was read from.
fn read(env: &crate::Env, scheme: &str) -> (Config, Vec<String>, Option<String>) {
    let home = env.get("HOME").cloned().unwrap_or_default();
    let xdg = env.get("XDG_CONFIG_HOME").filter(|x| !x.is_empty()).cloned().unwrap_or_else(|| format!("{home}/.config"));
    let mac = cfg!(target_os = "macos");
    let mut reader = Reader { home: home.clone(), xdg, seen: HashSet::new(), files: Vec::new(), own: Vec::new() };
    let mut paths = vec![format!("{}/ghostty/config.ghostty", reader.xdg), format!("{}/ghostty/config", reader.xdg)];
    if mac {
        paths.extend([format!("{home}/{MAC_APP_SUPPORT}/config.ghostty"), format!("{home}/{MAC_APP_SUPPORT}/config")]);
    }
    for path in &paths {
        reader.load(path);
    }
    let theme =
        reader.own.iter().rev().find(|(key, _)| key == "theme").map(|(_, value)| theme_for(value, scheme)).filter(|t| !t.is_empty());
    let mut config = Config::default();
    let mut files = reader.files;
    if let Some(name) = &theme {
        let dirs: Vec<String> = if name.starts_with('/') {
            vec![String::new()]
        } else {
            let shared: Vec<String> =
                if mac { vec![MAC_BUNDLED_THEMES.to_owned()] } else { LINUX_SHARED_THEMES.map(str::to_owned).to_vec() };
            std::iter::once(format!("{}/ghostty/themes", reader.xdg)).chain(shared).collect()
        };
        for dir in dirs {
            let path = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            let Some(text) = read_text(&path) else { continue };
            files.push(path);
            for (key, value) in directives(&text) {
                if key != "theme" && key != "config-file" {
                    config.apply(&key, &value);
                }
            }
            break;
        }
    }
    for (key, value) in &reader.own {
        config.apply(key, value);
    }
    (config, files, theme)
}

async fn call(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let asked: In = input(NAME, arguments)?;
    let (config, files, theme) = read(host.env(), asked.scheme.as_deref().unwrap_or("dark"));
    let structured = config.json(&files, theme.as_deref());
    let text = config.lines(&files, theme.as_deref(), &record::words().no_terminal_config).join("\n");
    Ok(Answer { text, structured, error: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        super::super::held::to_the_record::<In, Out>(TOOL.listed);
    }

    #[test]
    fn numbers_and_themes_read_as_javascript_reads_them() {
        for (text, want) in
            [("12", 12.0), (" 0x1F ", 31.0), ("1e2", 100.0), (".5", 0.5), ("5.", 5.0), ("", 0.0), ("-Infinity", f64::NEG_INFINITY)]
        {
            assert_eq!(js_number(text), want, "{text:?}");
        }
        for text in ["1_000", "inf", "0x", "1e", "abc", "+-1", "1.2.3"] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
        assert_eq!(theme_for("light:A, dark:B", "dark"), "B");
        assert_eq!(theme_for(" One ", "dark"), "One");
        assert_eq!(theme_for("light:A", "dark"), "");
    }

    #[test]
    fn a_config_is_written_in_the_order_its_files_set_it() {
        let mut config = Config::default();
        for (key, value) in [
            ("cursor-style-blink", "true"),
            ("background", "#0a0b0c"),
            ("font-size", "13.5"),
            ("cursor-style-blink", ""),
            ("cursor-style-blink", "false"),
            ("palette", "0x3=#ffffff"),
        ] {
            config.apply(key, value);
        }
        let json = config.json(&["/c".to_owned()], Some("T"));
        assert!(json.ends_with(r#""background":{"r":10,"g":11,"b":12},"fontSize":13.5,"cursorStyleBlink":false,"theme":"T"}"#), "{json}");
        assert!(json.contains(r#"null,null,null,{"r":255,"g":255,"b":255},null"#), "{json}");
    }
}
