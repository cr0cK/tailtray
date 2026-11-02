.PHONY: check pack install clean

UUID = tailtray@cr0ck.github.io
SRC = src
DIST = dist
BUNDLE = $(DIST)/$(UUID).shell-extension.zip
MODULES = $(wildcard $(SRC)/*.js)
# gnome-extensions pack takes extension.js, prefs.js, metadata.json, and schemas/ on its own.
EXTRA_SOURCES = $(filter-out $(SRC)/extension.js $(SRC)/prefs.js,$(MODULES)) \
	$(wildcard $(SRC)/*.svg) LICENSE

check:
	glib-compile-schemas --strict --dry-run $(SRC)/schemas
	for module in $(MODULES); do node --check $$module || exit 1; done
	node --test tests/*.test.js
	mkdir -p $(DIST)
	gnome-extensions pack --force \
		$(addprefix --extra-source=,$(abspath $(EXTRA_SOURCES))) \
		--out-dir $(DIST) $(SRC)

pack: check

install: pack
	gnome-extensions install --force $(BUNDLE)

clean:
	rm -rf $(DIST)
