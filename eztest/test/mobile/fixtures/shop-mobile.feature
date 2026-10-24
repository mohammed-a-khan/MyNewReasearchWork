# A Gherkin feature on a native Android app, for the mobile tests. Synthetic.
@mobile @platform:android @app:com.shop.app
Feature: Mobile sign-in

  Scenario: Sign in on the device
    When I type "alice" into the Username field
    And I sign in on the device
    Then the status reads "Ready"
    And the screen contains "ORD-"
