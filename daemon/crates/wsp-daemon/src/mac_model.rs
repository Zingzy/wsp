// SPDX-License-Identifier: AGPL-3.0-only
//! Which Mac a computer's report names, off the registry.

/// The product name in `ioreg -rc IOPlatformDevice -k product-name`, which prints it as `"product-name" = <"...">`.
fn product_name_of(ioreg: &str) -> Option<String> {
    let at = ioreg.find("\"product-name\" = <\"")? + "\"product-name\" = <\"".len();
    let name = ioreg[at..].split("\">").next()?.trim_end_matches('\0').trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// Which Mac this is, read once: the product name first, since Apple silicon's model identifiers name no family, and
/// the model identifier where the registry names no product, as an Intel Mac's does not.
pub(crate) fn mac_model() -> Option<String> {
    static MODEL: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    MODEL
        .get_or_init(|| {
            if !cfg!(target_os = "macos") {
                return None;
            }
            let read = |file: &str, args: &[&str]| {
                std::process::Command::new(file)
                    .args(args)
                    .output()
                    .ok()
                    .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
                    .unwrap_or_default()
            };
            product_name_of(&read("ioreg", &["-rc", "IOPlatformDevice", "-k", "product-name"]))
                .or_else(|| Some(read("sysctl", &["-n", "hw.model"]).trim().to_owned()).filter(|model| !model.is_empty()))
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_macs_product_name_is_read_off_the_registry_and_nothing_where_it_names_none() {
        let ioreg = "+-o J714sAP  <class IOPlatformDevice>\n    {\n      \"product-name\" = <\"MacBook Pro (14-inch, M5)\">\n    }\n";
        assert_eq!(product_name_of(ioreg).as_deref(), Some("MacBook Pro (14-inch, M5)"));
        assert_eq!(product_name_of("+-o Root  <class IORegistryEntry>\n"), None);
        assert_eq!(product_name_of("\"product-name\" = <\"\">"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_reports_the_mac_it_is() {
        assert!(mac_model().is_some_and(|model| !model.is_empty()));
    }
}
