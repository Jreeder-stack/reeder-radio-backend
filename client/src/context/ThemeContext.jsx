import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "darkMode";

const ThemeContext = createContext({ darkMode: true, toggleDarkMode: () => {} });

function applyThemeClass(isDark) {
  if (isDark) {
    document.documentElement.classList.remove("light-theme");
  } else {
    document.documentElement.classList.add("light-theme");
  }
}

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const val = JSON.parse(saved);
      return val === true || val === false ? val : true;
    }
    const legacy = localStorage.getItem("dispatchDarkMode");
    if (legacy !== null) {
      const parsed = JSON.parse(legacy);
      if (parsed === true || parsed === false) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        localStorage.removeItem("dispatchDarkMode");
        return parsed;
      }
    }
    return true;
  } catch {
    return true;
  }
}

export function ThemeProvider({ children }) {
  const [darkMode, setDarkMode] = useState(() => {
    const initial = readStoredTheme();
    applyThemeClass(initial);
    return initial;
  });

  useEffect(() => {
    applyThemeClass(darkMode);
  }, [darkMode]);


  useEffect(() => {
    const handler = (e) => {
      if (e.key === STORAGE_KEY && e.newValue !== null) {
        try {
          const next = JSON.parse(e.newValue);
          setDarkMode(next);
        } catch {}
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ darkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
