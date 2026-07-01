// Web stub: the chat demo uses the native nitro transport + op-sqlite (see ChatScreen.tsx). The web
// target ships the ledger; this keeps native-only modules out of the web bundle. Metro picks this
// file on web and ChatScreen.tsx on native.
import { Text, View } from "react-native";

export function ChatScreen() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ fontSize: 16, color: "#6f6a5c", textAlign: "center" }}>
        The chat demo runs on the native app. This web build serves the ledger.
      </Text>
    </View>
  );
}
