package io.eztest.agent.core;

import static org.junit.Assert.assertTrue;

import java.io.File;
import org.junit.Test;

/** Gradle unit test (`gradle :app:testDebugUnitTest`): the agent's request handling on the JVM. */
public class AgentCoreTest {
    @Test
    public void handlesTheAgentProtocol() throws Exception {
        File fixture = new File("../../../test/mobile/fixtures/shop-android.xml");
        assertTrue("fixture " + fixture.getAbsolutePath(), fixture.exists());
        assertTrue(AgentCoreChecks.run(fixture) > 30);
    }
}
