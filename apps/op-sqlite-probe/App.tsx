import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { runOpSqliteLedgerProbe } from "./src/ledger-probe";
import { runMultiDeviceSyncProbe } from "./src/sync-probe";

type ProbeState =
  | { status: "running" }
  | { status: "pass" }
  | { status: "fail"; reason: string };

export default function App() {
  const [probe, setProbe] = useState<ProbeState>({ status: "running" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await runOpSqliteLedgerProbe();
        if (cancelled) return;
        console.log("OP-SQLITE-DEVICE: PASS");
        await runMultiDeviceSyncProbe();
        if (cancelled) return;
        console.log("SYNC-DEVICE: PASS");
        setProbe({ status: "pass" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (cancelled) return;
        console.log(`DEVICE-PROBE: FAIL ${reason}`);
        setProbe({ status: "fail", reason });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      {probe.status === "running" ? (
        <>
          <ActivityIndicator size="large" />
          <Text style={styles.label}>Running op-sqlite ledger probe…</Text>
        </>
      ) : null}
      {probe.status === "pass" ? (
        <Text style={styles.pass}>OP-SQLITE-DEVICE: PASS</Text>
      ) : null}
      {probe.status === "fail" ? (
        <Text style={styles.fail}>OP-SQLITE-DEVICE: FAIL {probe.reason}</Text>
      ) : null}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  label: {
    marginTop: 16,
    fontSize: 16,
  },
  pass: {
    fontSize: 18,
    fontWeight: "600",
    color: "#0a7a2f",
    textAlign: "center",
  },
  fail: {
    fontSize: 16,
    fontWeight: "600",
    color: "#b00020",
    textAlign: "center",
  },
});
